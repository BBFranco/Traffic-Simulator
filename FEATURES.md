# Traffic Simulator — Features & Technical Reference

This document describes every major feature of the app, the math behind vehicle
behaviour and signal control, and how data flows from a simulation run into the
database and back out as dashboard metrics.

The simulator is entirely client-side (JavaScript, `resources/js/sim/**`):
Laravel never executes physics. The backend's job is auth, serving corridor
configs, and storing/aggregating run results that the browser (or a headless
Node CLI) POSTs to it.

> **Note on realism:** the current road network ("Hatfield corridor") uses
> uniform, assumed geometry (e.g. constant 245 m block spacing), not surveyed
> real-world data. Treat all corridor-specific numbers below as a placeholder
> scenario, not a validated model of the real Hatfield/Pretorius/Francis Baard
> intersections.

---

## 1. Car-Following Model — Intelligent Driver Model (IDM)

File: `resources/js/sim/equations.js`, `resources/js/sim/car.js`

The simulator implements the **Intelligent Driver Model** (Treiber, Hennecke &
Helbing, 2000, *"Congested Traffic States in Empirical Observations and
Microscopic Simulations,"* Phys. Rev. E 62(2)).

```js
export function idmAcceleration(v, v0, dv, s, params = IDM_DEFAULTS) {
    const { a, b, s0, T, delta } = params;
    const sStar = s0 + v * T + (v * dv) / (2 * Math.sqrt(a * b));
    return a * (1 - Math.pow(v / v0, delta) - Math.pow(sStar / s, 2));
}
```

- **Acceleration:** `a_α = a · [ 1 − (v/v0)^δ − (s*(v,Δv)/s)² ]`
- **Desired minimum gap:** `s*(v,Δv) = s0 + v·T + (v·Δv) / (2·√(a·b))`

| Variable | Meaning |
|---|---|
| `v` | current speed of the car (m/s) |
| `v0` | this car's desired/free-flow speed (m/s) |
| `Δv` | closing speed on the leader = `v − v_lead` (positive = approaching) |
| `s` | actual bumper-to-bumper gap to the vehicle ahead (m) |

Default parameters (`IDM_DEFAULTS`):

| Param | Value | Meaning |
|---|---|---|
| `a` | 1.4 m/s² | max acceleration |
| `b` | 2.0 m/s² | comfortable braking deceleration |
| `s0` | 2.0 m | minimum gap at standstill |
| `T` | 1.5 s | desired time headway |
| `δ` | 4 | acceleration exponent |

**Free-flow case** (no leader) collapses to just the speed term:
```js
return params.a * (1 - Math.pow(v / car.desiredSpeedMps, params.delta));
```

**Gap computation** (`car.js`, `carAcceleration`) — positions are vehicle
centres, so each vehicle's half-length is subtracted to get a true
bumper-to-bumper gap. A leader with no length (e.g. a virtual red-light
obstacle, see below) contributes zero:
```js
const occupiedLengthM = ((ahead.lengthM ?? 0) + car.lengthM) / 2;
const gap = Math.max(ahead.distanceM - occupiedLengthM - car.distanceM, 0.1);
const dv = v - ahead.speedMps;
return idmAcceleration(v, car.desiredSpeedMps, dv, gap, params);
```
Gap is floored at 0.1 m to avoid division blow-up.

**Integration** (explicit Euler, per tick `dt`):
- Raw IDM acceleration is clamped to `MAX_DECEL_MPS2 = 9` (~0.9g) as an
  engineering safety bound — needed because a signal can turn red the instant
  a car reaches the line, producing a one-tick near-zero-gap artifact.
- `newSpeed = max(0, v + accel·dt)` — never reverses.
- `distanceM += newSpeed · dt`.
- `STOPPED_SPEED_MPS = 0.3` m/s is the threshold below which a car counts as
  "stopped" for wait-time/queue statistics.

**Red signals as virtual vehicles:** a red/yellow light (or an all-way-stop
hold) is represented as a stationary virtual car at the stop line
(`{distanceM, speedMps: 0, isSignal: true}`) fed through the *same* IDM call —
braking for a red light is never a separate hand-rolled formula.

**Startup/reaction-lag gate:** when a stopped car (`v < STOPPED_SPEED_MPS`)
first computes a positive acceleration, a per-car randomized
`startupDelayS` (seeded, up to 0.8 s) must elapse before it's allowed to
actually accelerate — this prevents a whole lane of cars pulling away from
a green light in perfect lockstep.

---

## 2. Lane Changing — MOBIL

File: `resources/js/sim/equations.js`, applied per-car via `mobilParams` in `car.js`

Implements **MOBIL** (Kesting, Treiber & Helbing, 2007, *"General
Lane-Changing Model MOBIL for Car-Following Models,"* TRR 1999(1)).

**Safety criterion** — a change is rejected if it would force the new
follower to brake harder than it safely can:
```
accNewFollowerAfter ≥ −bSafe
```

**Incentive criterion** (symmetric — no lane-bias term, since this network
has no signed keep-left/right convention):
```
(accSelfAfter − accSelfBefore)
  + p · [ (accNewFollowerAfter − accNewFollowerBefore)
        + (accOldFollowerAfter − accOldFollowerBefore) ]
  > aThr
```
```js
export function mobilShouldChangeLane(
    { accSelfBefore, accSelfAfter, accNewFollowerBefore, accNewFollowerAfter,
      accOldFollowerBefore, accOldFollowerAfter },
    params = MOBIL_DEFAULTS
) {
    if (accNewFollowerAfter < -params.maxSafeDecelMps2) return false; // safety
    const incentive =
        accSelfAfter - accSelfBefore +
        params.politeness * (accNewFollowerAfter - accNewFollowerBefore
                            + (accOldFollowerAfter - accOldFollowerBefore));
    return incentive > params.changeThresholdMps2;
}
```
Every `acc*` term is an IDM acceleration evaluated before/after the
hypothetical change.

Defaults (`MOBIL_DEFAULTS`):

| Param | Value | Meaning |
|---|---|---|
| `politeness` (p) | 0.15 | 0 = purely selfish, 1 = fully weighs impact on other drivers |
| `changeThresholdMps2` (aThr) | 0.2 m/s² | min acceleration gain worth changing lanes for |
| `maxSafeDecelMps2` (bSafe) | 4.0 m/s² | hardest braking a change may impose on the new follower |

**Engine-level guards** (`engine.js`, `_performLaneChanges`/`_tryChangeLane`),
on top of the MOBIL math itself:
- `LANE_CHANGE_COOLDOWN_S = 4s` — no re-evaluating right after a change.
- `LANE_CHANGE_MIN_DISTANCE_M = 15m` — no lane changes right after spawning.
- `LANE_CHANGE_STOPLINE_EXCLUSION_M = 20m` — no changes right before a stop line.
- `MIN_LANE_CHANGE_GAP_M = 2m` — hard physical minimum gap, independent of MOBIL.
- Whichever adjacent lane yields the largest acceleration gain is chosen.
- A cosmetic `laneChangeAnim` eases the *rendered* lateral offset over 0.8 s
  (`LANE_CHANGE_ANIM_DURATION_S`), while the underlying physics/lane
  assignment switches instantly.

---

## 3. Vehicle Types & Truck Mix

File: `resources/js/sim/car.js` (`VEHICLE_TYPES`)

| Type | Length | Width | Speed factor | IDM (a, b) | MOBIL overrides |
|---|---|---|---|---|---|
| car | 4.5 m | 1.9 m | 1.0 | defaults (1.4, 2.0) | defaults |
| truck_small | 7.5 m | 2.3 m | 0.93 | (1.2, 1.9) | politeness 0.25, threshold 0.4, maxSafeDecel 3.2 |
| truck_medium | 10.5 m | 2.45 m | 0.87 | (1.0, 1.7) | politeness 0.3, threshold 0.5, maxSafeDecel 3.0 |
| truck_large | 14.5 m | 2.55 m | 0.8 | (0.8, 1.5) | politeness 0.35, threshold 0.6, maxSafeDecel 2.8 |

- **Gap physics:** `lengthM` feeds directly into the IDM gap calculation, so a
  longer truck ahead correctly reduces the true bumper-to-bumper gap.
- **Acceleration:** trucks get mildly reduced `a`/`b` — deliberately not
  drastic, since standstill gap (`s*` as `v,Δv→0` reduces to `s0`) is
  unaffected, so a stopped truck's minimum gap equals a car's (2.0 m); only
  the dynamic approach behaviour is gentler.
- **Desired speed:** scaled down 7–20% via `desiredSpeedFactor`.
- **Lane changing:** trucks are more "polite," need a bigger payoff to
  bother changing lanes, and demand an easier gap before committing —
  modelling worse mirrors/blind spots and higher cost of misjudging a gap.
- The **truck-mix slider** on the Simulator page (0–50%) sets
  `truckRatio` via `engine.setTruckRatio()`; each spawn independently rolls
  `car` vs. uniformly one of the three truck sizes. The renderer draws each
  truck size in a distinct colour from the car palette.
- The **bus-mix slider** (0–30%) sets `busRatio` via `engine.setBusRatio()`
  for a single 12 m `bus` type (heavy-vehicle IDM/MOBIL values between the
  medium and large truck). Buses take the band just above `truckRatio` on the
  same RNG draw, so 0% buses leaves the RNG sequence unchanged; batch runs and
  replays always use 0% trucks and buses.

---

## 4. Randomness

File: `resources/js/sim/rng.js`

A seeded **mulberry32** PRNG (`SeededRandom`, exposing `next()` → uniform
float in `[0, 1)`). Every stochastic decision in the sim draws from this
seeded generator, never `Math.random()`, so a `{seed, config}` pair
reproduces an identical run — required for headless batch determinism and
for paired comparisons across conditions.

Uses:
- **Vehicle arrivals** — Poisson inter-arrival sampling via inverse
  transform: `t = −ln(U) / λ` (Daganzo, 1997).
- **Radar sensor noise** — `noise = round((rng.next() − 0.5) · 2)`, i.e.
  roughly ±1 count of measurement noise.
- **Per-car startup delay** — reaction-lag before pulling away from a stop.
- **Desired-speed jitter** — ±8% (`DESIRED_SPEED_JITTER`).
- **All-way-stop dwell/hesitation jitter** — see §6.
- **Vehicle type roll** — car vs. truck size at spawn time.

No Gaussian/normal noise is used anywhere — all randomness is uniform or an
inverse-transform derivation of it.

---

## 5. Sensors

File: `resources/js/sim/sensors.js`

Sensors degrade the engine's ground-truth per-lane car list into what a real
detector would report — they add no new physics, only measurement error/limits.

`SENSE_WINDOW_M` (upstream range from the stop line, by sensor type):

| Sensor | Range |
|---|---|
| inductive_loop | 8 m |
| magnetometer | 15 m |
| radar | 60 m |
| camera | 120 m |

- `readQueueLength(cars, stopLineDistanceM, mode, rng)` — filters to stopped
  cars within the window:
  - `inductive_loop`: binary occupancy (0/1).
  - `radar`: exact stopped count ± rounded uniform noise in {−1,0,1}, floored at 0.
  - `magnetometer` / `camera`: exact count.
- `detectPresenceAtStopLine(cars, stopLineDistanceM, windowM=8)` — boolean
  "is anyone in the detector zone right now" (used for gap-out timing). Not
  filtered to stopped cars — a car rolling through on green still actuates
  it, matching a real gap timer.
- `sensorAvailable(mode, powerState, batteryBackedSensors)` — models
  load-shedding: cameras/radar always drop out on power loss (too
  power-hungry to battery-back); loops/magnetometers survive only if
  battery-backed sensors are enabled.

---

## 6. Traffic Signal Control Strategies

Files: `resources/js/sim/controllers/{fixedTime,adaptive,greenWave,allWayStop}.js`

All controllers share a 2-phase convention: **phase 0 = arterial through
movement, phase 1 = cross-street** (both cross directions together, since
they don't conflict). Shared transition timing: `YELLOW_S = 3`,
`ALL_RED_S = 1`.

### 6.1 Fixed-Time — Webster's Method

Timing is computed once (on load or demand change) and never adapts mid-cycle.

- **Optimum cycle length:** `C₀ = (1.5·L + 5) / (1 − Y)`, where `Y = Σyᵢ`
  and `yᵢ = qᵢ/sᵢ` (flow ratio per phase). Throws/falls back if `Y ≥ 1`
  (oversaturated) — falls back to a fixed 120 s cycle split evenly.
- **Green split:** `gᵢ = (yᵢ/Y) · (C − L)`, floored at `MIN_GREEN_S = 6`.
- `L = 2 × LOST_TIME_PER_PHASE_S` (lost time per phase = 4 s → L = 8 s).

Cited: Webster (1958).

### 6.2 Adaptive — Gap-Out / Min-Max Green

Min-green + gap-out extension, capped by max-green; won't switch away unless
the competing approach's call is judged "sufficient":

```js
tick(dt, vehicleDetectedThisTick, otherCallSufficient = false) {
    this.phaseElapsed += dt;
    if (this.phaseState === 'green') {
        this.secondsSinceLastDetection = vehicleDetectedThisTick
            ? 0 : this.secondsSinceLastDetection + dt;
        const extend = this.phaseElapsed < this.params.maxGreen &&
            (shouldExtendGreen(this.secondsSinceLastDetection, this.phaseElapsed, this.params)
             || !otherCallSufficient);
        if (!extend) { this.phaseState = 'yellow'; this.phaseElapsed = 0; }
    }
    // ... yellow -> allRed -> flip phase, same as fixed-time
}
```

- **Detection input:** did any car actuate the stop-line sensor zone this
  tick (`detectPresenceAtStopLine`).
- **"Sufficiency" of the other side's call** (decided by the engine, keeping
  the controller sensor-agnostic):
  - Narrow-window sensors (inductive loop 8m, magnetometer 15m — can't count
    queue depth): the call must persist uninterrupted for `callDebounceS`
    seconds.
  - Wide sensors (radar 60m, camera 120m): actual sensed queue depth via
    `readQueueLength()` compared against `minCallToSwitch`.
- Governing constants (`ADAPTIVE_DEFAULTS` in equations.js): `minGreen`,
  `maxGreen`, `gapOutS = 3s`, `minCallToSwitch = 5` vehicles,
  `callDebounceS = 3s`.

### 6.3 Green Wave — Progression Offsets

Stateless: phase/state is derived purely from `simTimeS mod cycleLengthS`
plus a fixed per-node offset — never drifts, loses nothing if rebuilt.

- One **shared** Webster cycle/split for the whole arterial (using the
  arterial's flow ratio and the average cross-street flow ratio).
- **Offset chain:**
  `offset[i] = offset[i−1] + greenWaveOffset(distanceToNext[i−1], targetSpeed)`,
  where `greenWaveOffset(distance, speed) = distance / speed` (Roess,
  Prassas & McShane, 2004) — the downstream light turns green exactly as
  long as a car at the progression speed takes to arrive.
- For the Hatfield corridor's uniform 245 m blocks at 50 km/h (13.89 m/s),
  this yields a constant **17.6 s** offset per intersection (documented
  directly in the corridor JSON).

### 6.4 All-Way-Stop — Load-Shedding Fallback

When a signal is dark (see §8, power outages), every approach becomes
stop-controlled. The controller class itself is largely inert; real
arbitration lives in `engine.js` (`_updateAllWayStopReleases`):

1. **Randomized per-approach dwell:** `requiredDwellS = MIN_STOP_DWELL_S(2) +
   rng()·STOP_DWELL_JITTER_S(2.5)`, rolled once when an approach transitions
   empty→queued.
2. **Junction occupancy lock:**
   `junctionClearTimeS = (max(crossWidth, arterialWidth) + 5m) / 6 m/s` —
   after any release, the node is locked for that duration to prevent
   simultaneous conflicting releases.
3. **True first-come-first-served** between arterial and cross-street sides
   (compares arrival timestamps), not fixed alternation — alternation let a
   heavy-traffic side win the lock race repeatedly and starve a lighter side.
4. **Release hesitation:** an extra `0.4s–2.0s` random reaction lag beyond
   the generic startup delay, once a car is released.

---

## 7. Simulation Engine

File: `resources/js/sim/engine.js`

**Timestep:** fixed at `FIXED_DT_S = 0.1s` (10 Hz), whether driven by the
live UI's accumulator loop or a headless batch runner calling `tick(dt)`
directly — the engine itself is render-agnostic.

**Per-tick sequence** (`SimulationEngine.tick(dt)`):
1. Advance `simTimeS`; re-evaluate power state (rebuild all controllers if
   it just changed).
2. Tick every intersection's controller (adaptive gets detection + call
   info, green-wave gets `simTimeS`, others get plain `dt`).
3. Resolve all-way-stop releases (load-shedding fallback).
4. Spawn, then step, every arterial's cars (cross-routing → MOBIL lane
   changes → IDM car-following/removal), in separate passes so spawns never
   influence the same-tick step.
5. Spawn, then step, every connector's (cross-street) cars.
6. Prune the 60s rolling stats window; sample the live chart.

**State:** `arterialState: Map<id, {mode, spawnRate, road, lanes:[{cars:[],
timerS, nextArrivalS}], stats}>` and a parallel `connectorState` for
cross-streets. Each lane is a live array of `Car` objects, kept sorted
front-first every step.

**Spawning:**
- Poisson arrivals per lane (`nextPoissonArrival`, λ derived from
  veh/lane/min demand).
- Demand can be **flat** or **sinusoidally fluctuating**:
  `demand(t) = mid + amplitude·sin(2πt/period)` — the Hatfield corridor uses
  a 300 s period. Fixed-time/green-wave still time to the midpoint ("design
  flow") and go stale as live demand drifts — deliberate, to expose the
  contrast against adaptive control.
- Spawn is gated by clearance: a new car only enters if the lane's front-most
  car is farther than `length + 4m` from the entry point; otherwise the
  timer holds and retries next tick.
- Truck-type roll and ±8% desired-speed jitter happen at spawn time.

**Removal:** cars are shifted off once their position passes the road's full
drawn length, incrementing cleared-vehicle counters. Cars can also be
"diverted" onto a cross-street connector mid-arterial (cross-routing) — this
is a transfer, not a spawn/clear event, so `spawned = cleared + on-road`
remains an internal consistency invariant.

**Signals as virtual obstacles:** a red/all-way-stop node is turned into a
stationary virtual car at the stop line and merged into the same
"nearest vehicle ahead" lookup IDM uses — no separate stopping logic exists.

---

## 8. Corridor / Road Network Model

File: `resources/js/sim/corridor.js`, `corridors/hatfield-pretorius-francisbaard.json`

Pure JSON → geometry loader (metres; x=east, y=south; left-hand traffic).

- **Arterials** — one-way roads, straight or Bezier-curved (curves sampled
  into an arc-length table so curved/straight roads are physics-identical).
  Each has a lead-in `approachLengthM` (spawn point) and run-out
  `exitLengthM`; total length is the removal threshold.
- **Intersections** — walked in order along the arterial, each carrying
  local heading, cross-axis, junction box size, and per-approach geometry
  (stop-line setback, per-lane centre offsets).
- **Connectors** (cross-streets) — link exactly two arterial intersections,
  with stub tips (default 70 m) extending past both so they read as
  through-streets. If no real connector serves an intersection, a synthetic
  2-lane stub is generated purely for visual 4-way completeness (no demand).
- **Arterial vs. side-street is structural**: arterials carry a
  controller-selectable mode (fixed/adaptive/green_wave/none); connectors
  are always plain "cross" approaches defaulting to fixed timing, since
  two-way cross-streets have no single progression band to coordinate. This
  structural split is what the Total/Arterial/Side-Streets scope filter
  (§10) reads.

**Hatfield corridor** (current scenario, placeholder geometry):
- Two parallel one-way 4-lane arterials — **Francis Baard** (westbound) and
  **Pretorius** (eastbound) — target speed 50 km/h, `mode: fixed` by default.
- 4 signalised intersections per arterial, **uniform 245 m** block spacing
  (explicitly documented in the corridor file as an assumed value, not
  surveyed).
- 4 two-way, 2-lane cross-streets (Jan Shoba, Grosvenor, Hilda, Festival)
  each linking one Pretorius node to one Francis Baard node; 22% chance an
  arterial kerb-lane car turns off at each.
- Demand: arterials 3–15 veh/lane/min (midpoint 9), cross streets 1–7
  veh/lane/min, both fluctuating on a 300 s sinusoid. Saturation flow 1900
  veh/lane/hr (arterial) / 1800 (cross).

---

## 9. Power Outages ("Load Shedding") & Recovery

- **Injection is engine-level "power state,"** not a separate module.
  `_computePowerState()` runs every tick: manual toggle forces
  load-shedding unconditionally; a scheduled mode computes
  `simTimeS % periodMinutes < offMinutes` for rotating (ESKOM-style) cuts.
  The instant state flips, every intersection's controller is rebuilt.
- When load-shedding is active, every intersection's controller becomes
  `AllWayStopController` (§6.4) — dark signals, stop-sign rules.
- Signal heads render uniformly dim during an outage; sensors degrade per
  `sensorAvailable()` (cameras/radar always drop; loop/magnetometer survive
  only with battery backup enabled).
- **Public toggles:** manual trigger button, or a scheduled
  off-minutes/period-minutes pair on the Simulator page.

**Recovery-time measurement** (`runHeadless.js`, `computeRecoverySeconds()`):
1. Compute a pre-outage baseline (mean of the metric over all pre-outage ticks).
2. Compute a threshold: `baseline × 0.8` for "higher is better" metrics
   (throughput) or `baseline × 1.25` with an inverted comparison for "lower
   is better" metrics (wait time).
3. Take a **trailing 300 s rolling average** of the post-restoration series
   (300 s deliberately matches the demand-fluctuation period, cancelling
   normal cyclic noise) and find the *last* point still failing the
   threshold; recovery time is the point right after it. This specifically
   avoids both raw-noise false positives and a healthy tail diluting an
   early bad patch.
4. Returns `null` if power never went out, or recovery never sustains before
   the run ends.

Two independently tracked recovery metrics exist per scope (Total/Arterial/
Side-Street):
- **`time_to_recovery_seconds`** — throughput-based (despite the results
  page's original "seconds back to pre-cut wait" caption; a migration
  comment explicitly documents this mismatch).
- **`time_to_recovery_wait_seconds`** — the later, genuinely wait-based twin
  metric, using the inverted "lower is better" threshold logic.

Separately, **segment stats** (`avg_wait_time_pre_outage`,
`..._during_outage`, `..._post_recovery`, throughput equivalents) are
computed from cumulative counters at exact tick boundaries — precise
before/during/after averages, independent of the smoothed recovery-time
calculation, so recovery deltas are never shown without matching
steady-state context.

---

## 10. Experimental Matrix & Batch Runs

File: `resources/js/sim/experimentalMatrix.js`

Defines the 12-condition batch matrix (controller mode × power state ×
sensor mode), shared verbatim between the CLI batch driver and the Results
page's "Generate dataset" button so they can't drift apart:

```
for powerState in [normal, load_shedding]:
    fixed_{powerState}        (sensorMode: inductive_loop — unused by fixed-time)
    green_wave_{powerState}   (sensorMode: inductive_loop — unused by green-wave)
    for sensorMode in [inductive_loop, radar, camera, magnetometer]:
        adaptive_{powerState}_{sensorMode}
# = 2 × (1 fixed + 1 green_wave + 4 adaptive) = 12 conditions
```
Fixed-time never reads a sensor and green-wave times off distance/speed
rather than a sensed queue, so only `adaptive` is tested across all four
sensor modes.

**Paired seeding:** every controller/sensor combination at a given power
state uses the *same* RNG seed per repetition
(`baseSeed + (loadShedding?10000:0) + rep`), so every condition sees an
identical arrival sequence — enabling paired statistical comparisons.

**Warm-up:** `WARMUP_TICKS = 3600` (6 simulated minutes) — the engine runs
from empty for this long, then `resetStats()` zeroes all cumulative
counters (without touching cars on the road, RNG, or power state) so
measurement starts from an already-equilibrated network. Confirmed
sufficient via `plateau.js`'s convergence detector (early-half vs. late-half
mean comparison over 300 s windows, 5% tolerance) — do not increase without
re-running that diagnostic.

**Batch run** ("Generate dataset (360 runs)" on the Results page): runs
30 reps × 12 conditions = 360 headless simulation runs directly in the
browser tab, each 40 measured minutes (24000 ticks) with outage injected at
25%–50% of the measured window. Progress is shown live; on completion a
success toast plus a 4-second `fireworks-js` celebration animation fires.

---

## 11. Data Persistence

### 11.1 `simulation_runs` table

One row = one completed run's summary.

| Column | Type | Notes |
|---|---|---|
| `id` | bigint PK | |
| `seed` | integer | PRNG seed |
| `controller_mode` | enum(fixed, adaptive, green_wave) | |
| `power_state` | enum(normal, load_shedding) | |
| `sensor_mode` | enum(inductive_loop, radar, camera, magnetometer), nullable | null for fixed-time |
| `corridor_config` | string | corridor JSON id |
| `avg_wait_time`, `throughput_per_min`, `pct_cleared_without_stop` | float | Total-scope headline metrics |
| `time_to_recovery_seconds` | float, nullable | throughput-based recovery (see §9) |
| `time_to_recovery_wait_seconds` | float, nullable | wait-based recovery twin |
| `*_arterial`, `*_side_street` | float, nullable | scoped counterparts of every metric above |
| `avg_wait_time_pre_outage/during_outage/post_recovery`, throughput equivalents | float, nullable | segment stats, Total + scoped |
| `median_wait_time`, `p95_wait_time`, `max_wait_time` | float, nullable | Total-scope only |
| `raw_config_json` | json | full run config, for replay |
| `created_at` | timestamp | no `updated_at` — immutable record |

### 11.2 `simulation_run_recovery_ticks` table

One row = one averaged tick sample of a condition's recovery curve
(averaged across every load-shedding rep of that controller/sensor/corridor
combination, downsampled to ≤300 points).

Columns: `id`, `controller_mode`, `sensor_mode` (nullable), `corridor_config`,
`tick`, `seconds`, `throughput_per_min` (+ `_arterial`/`_side_street`),
`avg_wait_time` (+ `_arterial`/`_side_street`), `power_event_seconds`
(outage start), `power_outage_end_seconds` (outage end), `created_at`.
Indexed on `(corridor_config, controller_mode, sensor_mode)`.

### 11.3 End-to-end flow

1. **Run** — `runHeadless.js` (or the interactive engine) steps
   `SimulationEngine` on a fixed 0.1s timestep, producing
   `{rows, sideStreetRows, summary}`. `buildSummary()` computes true
   whole-run averages from cumulative counters, weighting each arterial by
   its own cleared count, then blends Arterial + Side-Street into Total.
2. **Payload** — `apiPayload.js` (`toApiPayload()`) renames the camelCase
   summary into the exact snake_case column set of `simulation_runs`.
3. **POST `/api/simulation-runs`** (outside the `auth` group, CSRF-exempt —
   the headless CLI runner has no browser session) →
   `SimulationRunController::store()`, validated by
   `StoreSimulationRunRequest` (per-field rules on the `runs[]` array), then
   bulk-inserted via `Eloquent::insert()`.
4. **Recovery ticks** — `recoveryTickPayload.js` accumulates sums across
   every rep of a condition, then finalizes into per-tick averages.
   **POST `/api/recovery-ticks`** → `RecoveryTickController::store()`,
   validated by `StoreRecoveryTicksRequest`, which first **deletes** any
   existing series for that exact `(controller_mode, sensor_mode,
   corridor_config)` key (replace, not accumulate), then bulk-inserts.

### 11.4 Corridor config storage

`app/Support/CorridorRepository.php` reads corridor layout JSON from a
`corridors/*.json` directory on disk — the single source of truth for both
the browser and any Node CLI tooling. A corridor's `id` is what's stored
verbatim in both tables' `corridor_config` column.

### 11.5 Routes

| Route | Controller | Notes |
|---|---|---|
| `GET /simulator` | `SimulatorController::index` | auth |
| `GET /corridors/{corridor}` | `SimulatorController::corridor` | auth |
| `GET /simulator/sample-runs` | `SimulatorController::sampleRuns` | auth; one representative run per condition, for the replay picker |
| `GET /results` | `ResultsController::index` | auth |
| `GET /results/data` | `ResultsController::data` | auth; AJAX partial refresh |
| `POST /api/simulation-runs` | `SimulationRunController::store` | no auth, CSRF-exempt |
| `POST /api/recovery-ticks` | `RecoveryTickController::store` | no auth, CSRF-exempt |

---

## 12. Metrics Computation (`ResultsController.php`)

- **Aggregates** — one row per `(controller_mode, power_state)`, via
  `avg(...)` over every scoped metric column, plus a second breakdown
  additionally grouped by `sensor_mode`.
- **Confidence intervals** — since SQLite has no `STDDEV_SAMP`, sample
  standard deviation is computed in PHP from raw rows; each mean gets a 95%
  CI half-width of `1.96 × stddev / √n` (requires ≥2 reps).
- **Paired comparisons** — the core research-question logic: each of
  `adaptive`/`green_wave` vs. the `fixed` baseline, under each power state,
  per scope. Adaptive gets one row per sensor plus a blended "average of
  sensors" row. Computes wait/throughput delta %, cleared-without-stopping
  delta (percentage points), and both recovery-time deltas, with
  improves/worsens booleans.
- **Scope filter** — `'' → total`, `'_arterial' → arterial`,
  `'_side_street' → side_street` is the single mapping driving every scoped
  query and UI column; Total/Arterial/Side-Streets in the UI always resolve
  to this same suffix convention.
- **Segment metrics** — the pre/during/post-outage averages, aggregated
  like any other scoped metric, specifically to give recovery-time deltas
  matching steady-state context.
- **Recovery timeline** — reads `simulation_run_recovery_ticks`, grouped by
  `controller_mode|sensor_mode`, filtered by corridor, producing the
  per-scope series plus the outage-shading band for the recovery charts.

---

## 13. Simulator Page (Interactive)

Files: `resources/views/simulator.blade.php`, `resources/js/simulator.js`, `resources/js/sim/renderer.js`

**Controls:**
- **Corridor picker** — loads a JSON layout; description/fact chips update live.
- **Seed input + Random button** — same seed + config reproduces an
  identical run.
- **Replay a batch run** — loads one recorded run per (controller, sensor,
  power) condition from `/simulator/sample-runs`, forcing every control to
  match the recorded conditions, fast-forwarding through warm-up, then
  auto-triggering the power outage at the original tick and auto-pausing at
  the recorded duration's end.
- **Per-arterial signal mode** — Fixed-time / Adaptive / Green wave (plus a
  non-selectable "Free flow" for backbone roads with no signals).
- **Sensor model** — None (timer) / Inductive loop / Radar / Camera /
  Magnetometer, each annotated with detection range and power draw.
- **Power/outage** — manual trigger/restore toggle; scheduled rotating
  outages (off-minutes + period-minutes); battery-backed low-power sensors
  checkbox.
- **Demand** — per-arterial/connector veh/lane/min slider, or a min/max
  slider pair plus a live sinusoidal "now" readout for corridors with
  configured fluctuation.
- **Truck mix** — 0–50% slider, split evenly across the three truck sizes.

**Transport bar:** Play/Pause, Step (single 0.1s tick), "Run to t=1000s"
(bounded-per-frame catch-up so the tab stays responsive), Reset, and a
0.25×–16× speed control. The animation loop is a fixed-timestep accumulator
decoupled from real frame rate, so live play and headless batch runs are
driven by the identical engine code path.

**Canvas rendering:** road surfaces, dashed/solid lane markings, junction
boxes, stop lines, cars (colour-coded by type/size, brake-light red when
stopped), signal heads (red/amber/green lens, dimmed during outages),
distance annotations, name labels. Pan/zoom/zoom-to-fit, hover tooltips
(arterial, mode, queue length, live signal-phase debug info when running),
and layer toggles (names, lane markings, block distances, signal heads).

**Live stats:** sim clock, running/power/sensing-mode pills, per-arterial
stat cards (avg wait now/rolling, throughput, cars on road, % cleared
without stopping, per-segment cleared counts), and a live "vehicles cleared
over time" line chart.

---

## 14. Results / Dashboard Page

Files: `resources/views/results.blade.php`, `resources/js/results.js`, `resources/views/results/partials/*.blade.php`

- **"Generate dataset (360 runs)"** button — runs the full experimental
  matrix (§10) client-side with a live progress bar, POSTing results in
  batches of 25; on completion, re-fetches and swaps in fresh aggregate
  partials without a page reload, then shows a success toast + 4-second
  fireworks celebration animation.
- **Filters:** Corridor (server-side, reflected into the URL query string),
  "Compare against fixed-time" target (client-side — which ITS
  configuration the comparison cards use), Scope (Total / Arterial /
  Side-streets, client-side row/column visibility toggle).
- **Research question cards** — paired mode-vs-fixed-time comparisons
  (wait-time delta %, throughput delta %, cleared-without-stopping delta),
  colour-toned by whether they improve or worsen.
- **Metric section groups** — headline comparison cards for throughput,
  cleared-without-stopping, and both recovery-time metrics.
- **Per-condition charts + table** — grouped bar charts (mode × power
  state) for wait time, throughput, cleared-without-stopping, with a
  collapsible 95%-CI data table.
- **Load-shedding segmented table** — pre/during/post-recovery wait &
  throughput per mode, plus median/p95/max wait distribution (always
  Total scope).
- **Recovery charts** — wait & throughput line charts over simulated
  seconds with a shaded outage band, plus horizontal bar charts for both
  recovery-time metrics.
- **Recent runs table** — most recent 10 runs, independent of filters but
  highlighted/dimmed to match the current comparison target.

**Data access:** every chart has a "Show data table" toggle rendering the
same numbers as a plain HTML table (copyable, not a file export). No
CSV/PDF export or shareable-link feature beyond the corridor filter's URL
query param.

---

## 15. Theming

File: `resources/js/theme.js`, `resources/js/charts/theme.js`, `resources/js/sim/renderer.js`

- Light is the explicit default. `applyTheme()` toggles a `dark` class +
  `data-theme` attribute on `<html>`, persists to `localStorage`, and
  broadcasts a `theme:change` event that both the Simulator and Results
  pages subscribe to.
- **Canvas:** the renderer keeps two full colour palettes (light/dark)
  covering roads, markings, signal lenses, and vehicle colours; switching
  themes swaps the palette and redraws.
- **Charts:** text/grid/axis/tooltip colours re-theme, but **series colours
  stay constant** across themes by design (an entity shouldn't change
  colour when the user flips theme) — validated for contrast in both modes.
  Because Chart.js bakes colours in at construction, charts are fully
  rebuilt (not patched) after a theme change.

---

## 16. Summary of Key Constants

| Constant | Value | Where |
|---|---|---|
| Physics tick rate | 0.1 s (10 Hz) | engine.js |
| IDM: max accel `a` | 1.4 m/s² (car) | equations.js |
| IDM: comfortable decel `b` | 2.0 m/s² (car) | equations.js |
| IDM: min gap `s0` | 2.0 m | equations.js |
| IDM: time headway `T` | 1.5 s | equations.js |
| Emergency decel clamp | 9 m/s² | car.js |
| MOBIL politeness (car) | 0.15 | equations.js |
| MOBIL safety decel bound (car) | 4.0 m/s² | equations.js |
| Warm-up period | 3600 ticks (6 min) | results.js, batch tooling |
| Recovery smoothing window | 300 s | runHeadless.js |
| Demand fluctuation period (Hatfield) | 300 s | corridor JSON |
| Green-wave offset per block (Hatfield) | 17.6 s | corridor JSON (derived) |
| Experimental matrix | 12 conditions × 30 reps | experimentalMatrix.js |
| Batch run duration | 24000 ticks (40 measured min) | results.js |
