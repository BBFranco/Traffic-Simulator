# Traffic Simulator — Backend Logic & Formula Audit

Scope: `resources/js/sim/*.js`. Pure simulation core (`engine.js`) is
rendering-agnostic — `simulator.js` (browser, `FIXED_DT_S = 0.1s` per tick)
and `runHeadless.js` (batch mode) both drive the same `SimulationEngine`.

## 1. Car-following model (IDM)

**File:** [equations.js:27](../resources/js/sim/equations.js#L27), applied in [car.js:173](../resources/js/sim/car.js#L173)

Intelligent Driver Model — Treiber, Hennecke & Helbing (2000), *Congested
Traffic States in Empirical Observations and Microscopic Simulations*,
Physical Review E 62(2).

```
a = a_max * [ 1 - (v/v0)^delta - (s*(v,dv) / s)^2 ]
s*(v,dv) = s0 + v*T + (v*dv) / (2*sqrt(a_max*b))
```

- `v` current speed, `v0` desired speed, `dv = v - v_lead` (closing speed),
  `s` actual bumper gap.
- Defaults: `a=1.4 m/s², b=2.0 m/s², s0=2.0m, T=1.5s, delta=4`.
- With no leader, only the free-flow term `a*(1-(v/v0)^4)` applies — the
  interaction term vanishes as gap → ∞.

**Key audit points:**
- A red/yellow signal or a stop-controlled node is modelled as a **virtual
  stationary car** (`speedMps: 0`) at the stop line ([engine.js:731](../resources/js/sim/engine.js#L731),
  [engine.js:741](../resources/js/sim/engine.js#L741), [engine.js:766](../resources/js/sim/engine.js#L766)). Braking for a
  light and braking for real traffic go through the *exact same* `idmAcceleration()` call — there is no separate hand-rolled signal-braking formula. This is a deliberate design choice (see [car.js:1-9](../resources/js/sim/car.js#L1-L9)).
- Output is clamped to `MAX_DECEL_MPS2 = 9 m/s²` (≈0.9g) ([car.js:28](../resources/js/sim/car.js#L28)). This is **not** part of the cited IDM formula — it's an engineering clamp on top, justified as covering the one-tick discretisation artifact when a signal turns red just as a car reaches the line (gap ≈ 0 with no gradual closing). Worth flagging in an audit: it silently caps how hard a car can react to *any* near-zero-gap scenario, not just signals.
- Per-car `desiredSpeedMps` is jittered ±8% around the road's target speed ([engine.js:38](../resources/js/sim/engine.js#L38), `DESIRED_SPEED_JITTER`), and each car gets a randomized `startupDelayS` (0–0.8s, [engine.js:36](../resources/js/sim/engine.js#L36)) before pulling away from a stop, so a queue doesn't move off in perfect lockstep. Both are seeded RNG draws.
- Negative-velocity guard: if integration would drive speed below 0, it's clamped to 0 and a console warning fires above a `1e-6` float-noise threshold ([car.js:201-212](../resources/js/sim/car.js#L201-L212)) — a real math error would show up here, small numerical jitter at equilibrium won't.
- "Stopped" for all wait/queue stats is defined as `speedMps < STOPPED_SPEED_MPS (0.3 m/s)` ([car.js:14](../resources/js/sim/car.js#L14)), not exactly zero.
- Integration is simple Euler (`v += a*dt`, `x += v*dt`) at a fixed `dt = 0.1s` — no sub-stepping or RK4. At this timestep with the given IDM parameters this is standard practice, but it's worth knowing if you're auditing numerical accuracy.

## 2. Signal timing — Fixed-time (Webster's method)

**Files:** [equations.js:55](../resources/js/sim/equations.js#L55) (formula), [controllers/fixedTime.js](../resources/js/sim/controllers/fixedTime.js)

Webster, F.V. (1958), *Traffic Signal Settings*, Road Research Technical
Paper No. 39.

```
Optimum cycle:  C0 = (1.5*L + 5) / (1 - Y)         where Y = Σ yi (flow ratios)
Green split:    gi = (yi / Y) * (C - L)
flow ratio yi = qi / si   (demand flow / saturation flow, per lane)
```

- `L` = total lost time/cycle = `2 * LOST_TIME_PER_PHASE_S (4s) = 8s` for the two-phase (arterial/cross) structure used everywhere in this sim.
- **Undefined case:** if `Y >= 1` (oversaturated — demand can't be cleared at any cycle length), `websterOptimumCycle` throws by design (matches the theory — Webster's formula truly has no solution there). Every caller catches this and falls back to a fixed 120s cycle split 50/50 minus lost time ([fixedTime.js:39-44](../resources/js/sim/controllers/fixedTime.js#L39-L44), also in [greenWave.js:85-90](../resources/js/sim/controllers/greenWave.js#L85-L90)). This fallback is *not* cited — it's an engineering "don't crash the sim" choice, worth confirming is acceptable for whatever the audit needs to conclude about oversaturated behavior.
- Both computed greens are floored at `MIN_GREEN_S = 6s` regardless of what Webster's split produces ([fixedTime.js:46](../resources/js/sim/controllers/fixedTime.js#L46)) — this can make the *actual* cycle length longer than `C0` when one leg's demand is tiny, since the other phase doesn't shrink to compensate.
- Recomputed only when demand changes (`recompute()`), **not automatically each tick** — a live/fluctuating demand rate (see §5) can drift away from the fixed plan's design value over time, mirroring how a real timing plan goes stale. This is deliberate (see [engine.js:558](../resources/js/sim/engine.js#L558) comment).
- Phase sequence per node: `green → yellow (3s) → allRed (1s) → other phase green → ...` ([fixedTime.js:58](../resources/js/sim/controllers/fixedTime.js#L58)). Yellow/all-red durations (3s/1s) are hardcoded constants, not derived from any cited formula — standard textbook defaults, restated as `LOST_TIME_PER_PHASE_S = 4` (3+1).
- Only 2 phases exist: phase 0 = arterial through movement, phase 1 = both cross-street directions together (they don't conflict with each other, only with the arterial). No protected left-turn phase, no pedestrian phase.

## 3. Signal timing — Green wave / progression

**Files:** [equations.js:84](../resources/js/sim/equations.js#L84), [controllers/greenWave.js](../resources/js/sim/controllers/greenWave.js)

Roess, Prassas & McShane (2004), *Traffic Engineering*, 3rd ed.

```
offset = distance_between_intersections_m / target_progression_speed_mps
```

- One shared Webster cycle/split for the *whole arterial*: arterial flow ratio vs. the **average** cross flow ratio across all connector-bearing nodes on that arterial ([greenWave.js:76-90](../resources/js/sim/controllers/greenWave.js#L76-L90)). Individual nodes with heavier/lighter cross demand than the average don't get their own split — audit point if per-node accuracy matters.
- `targetSpeedKph` defaults to 50 km/h if unset ([engine.js:517](../resources/js/sim/engine.js#L517)) — this progression speed is *not necessarily* the posted/desired speed cars actually drive at (which comes from `arterial.targetSpeedKph` too, so in practice they're the same value here, but the code treats them as conceptually separate knobs).
- Unlike fixed-time, this controller is **stateless**: phase is derived directly from `simTimeS mod cycleLength` each tick ([greenWave.js:44](../resources/js/sim/controllers/greenWave.js#L44)), so nodes never drift out of sync and a demand-driven rebuild loses no state.
- Offsets chain sequentially down the arterial (each node's offset = previous node's offset + travel time from previous node), not computed independently per node from node 0 — so an error/rounding in one link propagates to all downstream nodes.

## 4. Signal timing — Adaptive (vehicle-actuated / SCOOT-like)

**Files:** [equations.js:119](../resources/js/sim/equations.js#L119) & [equations.js:133](../resources/js/sim/equations.js#L133), [controllers/adaptive.js](../resources/js/sim/controllers/adaptive.js)

**Explicitly not a single cited formula** — the file's own comment ([equations.js:106-114](../resources/js/sim/equations.js#L106-L114)) states this mirrors the general sense→process→execute loop of actuated/SCATS/SCOOT-style gap-extension logic (Lowrie 1990; Hunt et al. 1981) without one universal equation. Flagged here because an audit should treat this differently from the three cited formulas above.

Rules (`ADAPTIVE_DEFAULTS`: `extendThreshold=2 veh, minGreen=8s, maxGreen=45s, minCallToSwitch=5 veh`):
- Green always holds at least `minGreen` (8s), regardless of any call.
- Below `maxGreen` (45s), green extends if `sensedQueueOnGreenApproach > extendThreshold (2)`.
- Green also keeps extending indefinitely if the **other** phase has zero sensed queue ("resting on green" — no logic reason to switch) ([adaptive.js:47](../resources/js/sim/controllers/adaptive.js#L47)).
- If the other phase has a *small* call (`0 < queue < minCallToSwitch (5)`), current phase still gets to keep extending, but only up to `maxGreen` — a lone car on the minor approach can't preempt a busy phase, but isn't left waiting forever either ([adaptive.js:48-52](../resources/js/sim/controllers/adaptive.js#L48-L52)).
- At `maxGreen`, extension is forced off regardless of queue (hard cap).
- Same yellow (3s) / all-red (1s) clearance as fixed-time.
- **Queue input is sensor-degraded**, not ground truth — see §6. This means an adaptive controller's real-world behavior depends on `sensorMode`, and can under/over-react based on sensor limitations (e.g. `inductive_loop` only ever reports 0 or 1, so `extendThreshold=2` can never be exceeded via loop sensing alone — worth double-checking whether that's intended or a bug, since it means loop-sensed adaptive intersections can never gap-extend past the threshold check, only ride the "other phase has no call" branch).

## 5. All-way-stop (load-shedding fallback)

**File:** [controllers/allWayStop.js](../resources/js/sim/controllers/allWayStop.js)

Not modelled as a phased signal at all. Triggered when `powerState ===
'load_shedding'` (§7). Every approach becomes stop-controlled:
- No multi-way right-of-way arbitration between conflicting approaches is modelled — this is explicitly called out as a simplification in the file header.
- A car is released once it has been continuously stopped for `MIN_STOP_DWELL_S = 2s` at the front of its queue ([allWayStop.js:12](../resources/js/sim/controllers/allWayStop.js#L12), tracked in [engine.js:713-721](../resources/js/sim/engine.js#L713-L721)).
- Release is per-car (`releasedNodeId`), not per-phase — each car independently earns its own "go" once it's waited the dwell time, re-checked against the same node if it re-queues behind a car ahead of it.

## 6. Sensors (what the adaptive controller actually "sees")

**File:** [sensors.js](../resources/js/sim/sensors.js)

Not a physical hardware model — it degrades the engine's ground-truth queue count to whatever the configured sensor type would realistically report:

| mode | sense window | reported value |
|---|---|---|
| `inductive_loop` | 8m | binary occupancy: 0 or 1 only |
| `magnetometer` | 15m | exact count in window |
| `radar` | 60m | exact count ± random noise in {-1,0,+1} |
| `camera` | 120m | exact count in window (most accurate) |

- Only cars with `stoppedNow === true` and within the window ahead of the stop line count.
- Radar noise is drawn from the seeded RNG (reproducible per seed).
- Power-outage interaction ([sensors.js:46](../resources/js/sim/sensors.js#L46)): during `load_shedding`, camera/radar are assumed too power-hungry to battery-back and always go dark; loop/magnetometer survive only if `batteryBackedSensors` is enabled. This gate is checked by `sensorAvailable()` but note — **the adaptive controller itself is never even active during load-shedding** (§7 forces `allWayStop` for every mode), so this `sensorAvailable` flag is purely a UI-facing "would the sensor still work" readout at the moment, not something that changes actuated-controller behavior. Worth confirming that's intended.

## 7. Power / load-shedding state machine

**File:** [engine.js:456](../resources/js/sim/engine.js#L456)

- `power.manual` (a UI toggle) forces `load_shedding` immediately, unconditionally.
- `power.scheduled` runs a simple modulo duty cycle: `simTimeS % periodMinutes*60 < offMinutes*60` → load-shedding. This is a fixed repeating square wave, not tied to any real load-shedding stage schedule.
- Whenever computed power state *changes*, **every controller on every node is rebuilt** ([engine.js:466-472](../resources/js/sim/engine.js#L466-L472)) — fixed-time/adaptive/green-wave phase state is fully discarded and every intersection restarts at phase 0/green when power comes back, rather than resuming where it left off. This is a real behavioral choice worth flagging: a power blip mid-cycle resets every signal's timing, it doesn't pause and resume.
- During load-shedding, **mode selection is irrelevant** — `_rebuildController()` short-circuits to `allWayStop` before even checking `fixed`/`adaptive`/`green_wave` ([engine.js:535](../resources/js/sim/engine.js#L535)).

## 8. Demand model

**Files:** [equations.js:161](../resources/js/sim/equations.js#L161) (fluctuation), [corridor.js:57](../resources/js/sim/corridor.js#L57) (`buildDemand`)

- Base arrivals: Poisson process, inverse-transform sampling — `t = -ln(U)/λ` ([equations.js:100](../resources/js/sim/equations.js#L100)), Daganzo (1997). `λ` = spawn rate per lane per minute ÷ 60, floored at `0.01/60`/s to avoid a zero-rate divide/infinite wait.
- Optional fluctuating demand: `mid + amplitude*sin(2π*t/period)` between a configured min/max ([equations.js:161](../resources/js/sim/equations.js#L161)) — explicitly **not** a cited formula (no closed-form real demand curve exists; real ones are empirical fits like HCM's peak-hour factor). It's a documented stand-in.
- **Important audit point:** fixed-time and green-wave signal plans are computed from the *design* spawn rate (the midpoint / slider value, frozen at `recompute()`/`setDemand()` time), while the *live* spawn rate used to actually draw car arrivals keeps wandering per the sinusoid. This is intentional — a fixed plan is supposed to go stale as live conditions drift, exactly like a real fixed-time plan would — but it means comparing "signal plan assumptions" vs. "actual demand" requires looking at two different values (`state.spawnRatePerLanePerMin` vs. `liveSpawnRate()`).
- Default demand if unconfigured: arterial 8 veh/lane/min at 1900 veh/lane/hr saturation flow; connector 4 veh/lane/min at 1800 veh/lane/hr saturation flow ([corridor.js:236](../resources/js/sim/corridor.js#L236), [corridor.js:286](../resources/js/sim/corridor.js#L286)).
- Spawning is blocked if the nearest car in that lane is within `carLengthM + SPAWN_CLEARANCE_M (4m)` of the entry point ([engine.js:584](../resources/js/sim/engine.js#L584)) — the elapsed inter-arrival timer is *not* reset in that case, so a delayed spawn doesn't also incur a fresh full wait.

## 9. Cross-routing (arterial → side street diversion)

**File:** [engine.js:785](../resources/js/sim/engine.js#L785) (`_maybeCrossRoute` / `_divertCarToConnector`)

- Only the kerb (lane 0) can turn off.
- The dice roll (`connector.crossChance`, seeded RNG) happens once per (car, node) — only when the car is within `CROSS_DECISION_WINDOW_M (5m)` of a green stop line (not while queued behind red, to avoid burning re-rolls every tick).
- A blocked target lane (no gap within `carLengthM + SPAWN_CLEARANCE_M`) means the car just continues straight instead — it never "waits" to turn.
- Diverted cars are a **transfer**, not a despawn/respawn — they don't touch `totalSpawned`/`totalClearedNetwork` accounting, and carry over their current speed and colour. Purely cosmetic turn-sweep animation is separate from the physics (see [car.js:88-101](../resources/js/sim/car.js#L88-L101)).
- A connector spans two real intersections (near gate + far gate) — a car checks whichever it hasn't passed yet, nearest first ([engine.js:696-698](../resources/js/sim/engine.js#L696-L698)). One-way connectors only accept traffic entering at their own start node; turning on "against the flow" from the far node is rejected (car stays on the arterial).

## 10. Statistics/accounting definitions (relevant to auditing outputs, not inputs)

- "Stopped for signal" (`stoppedForSignal`) is only set if the resolved `ahead` obstacle was actually a signal (`isSignal: true`) at the moment the car registers as stopped — a car stopped behind *another car* (which itself is stopped for a light) is not itself flagged as signal-stopped.
- Queue length shown in the stats footer/tooltips (`_groundTruthQueue`/`_countQueued`) is ground truth (never touches RNG), separate from what the adaptive controller senses (§6) — the two can legitimately disagree, which is expected/by design, not a bug.
- Rolling wait/throughput stats use a 60s trailing window (`ROLLING_WINDOW_S`); cumulative "cleared over time" chart samples are never trimmed.
- `carAccounting()` provides a network-wide conservation check: `spawned == cleared + onRoad`, intended as a correctness self-test (build step 14 in the file's own step numbering) — good candidate to actually run if the audit wants a sanity check that no cars are silently vanishing/duplicating.

## 11. Summary table of hardcoded constants worth double-checking against whatever spec/reality this is meant to match

| Constant | Value | File |
|---|---|---|
| Yellow | 3s | fixedTime.js, adaptive.js, greenWave.js (each hardcodes its own copy) |
| All-red | 1s | same three files |
| Min green (fixed/green-wave floor) | 6s | fixedTime.js, greenWave.js |
| Lost time per phase | 4s | fixedTime.js, greenWave.js |
| Adaptive min/max green | 8s / 45s | equations.js `ADAPTIVE_DEFAULTS` |
| Adaptive extend threshold | 2 veh | equations.js |
| Adaptive min call to switch | 5 veh | equations.js |
| All-way-stop dwell | 2s | allWayStop.js |
| Max IDM deceleration clamp | 9 m/s² | car.js |
| Stopped-speed threshold | 0.3 m/s | car.js |
| Fixed timestep | 0.1s | simulator.js |
| Oversaturated fallback cycle | 120s (60/60 split) | fixedTime.js, greenWave.js |

Note: yellow/all-red/min-green/lost-time constants are **duplicated across
three controller files** rather than centralized — if these ever need to
change, all three need updating in lockstep (currently they do match, but
there's no shared constant enforcing that).
