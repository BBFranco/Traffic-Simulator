/**
 * runHeadless.js - build step 13.
 *
 * Same engine, no render: strips requestAnimationFrame and Canvas out of the
 * loop entirely and just steps `SimulationEngine` on a fixed timestep in a
 * plain `while` loop, so a batch of runs finishes in real compute time rather
 * than wall-clock animation time.
 *
 * Isomorphic on purpose - this file does no file I/O and touches no DOM, so
 * the exact same function runs both from the CLI batch driver
 * (`batch/runBatch.mjs`, Node) and from the `/results` page's batch-run
 * button (build step 17, browser). Only the caller differs in what it does
 * with the returned rows/summary.
 */
import { buildLayout } from './corridor.js';
import { SimulationEngine } from './engine.js';

/**
 * @param seed                 integer PRNG seed
 * @param controllerMode       'fixed' | 'adaptive' | 'green_wave' - applied to every arterial in the corridor
 * @param sensorMode           'none' | 'inductive_loop' | 'radar' | 'camera' | 'magnetometer'
 * @param warmupTicks          ticks run BEFORE anything is measured, discarded from every stat - the
 *                             standard traffic-sim warm-up: long enough for queue lengths/wait times to
 *                             leave their from-empty ramp-up transient under normal power, so the
 *                             outage and recovery windows below land inside an already-equilibrated
 *                             corridor instead of a still-filling one. Does not affect car conservation
 *                             (that check spans the whole run, warm-up included) - see engine.js's
 *                             resetStats(). 0 (the default) measures from t=0, same as before this existed.
 * @param powerOutageStartTick tick the outage begins at (relative to the END of warm-up, i.e. tick 0 of
 *                             the measured phase), or null for a normal-power run
 * @param powerOutageEndTick   tick power is restored at (same measured-phase-relative timing) - required
 *                             whenever `powerOutageStartTick` is set
 * @param corridorConfig       parsed corridor JSON (same shape `buildLayout()` already takes)
 * @param durationTicks        number of MEASURED ticks to run, after warm-up - `rows`/`sideStreetRows`
 *                             and every summary stat are scoped to this window only
 * @param dt                   physics timestep in seconds (must match the live sim's FIXED_DT_S for the sanity-check comparison in build step 13 to be meaningful)
 * @param sampleEverySeconds   how often (sim time) to emit a CSV row - spec explicitly says not literally every tick
 * @returns { rows: object[], sideStreetRows: object[], summary: object }
 */
export function runHeadless({
    seed,
    controllerMode,
    sensorMode,
    warmupTicks = 0,
    powerOutageStartTick = null,
    powerOutageEndTick = null,
    corridorConfig,
    durationTicks,
    dt = 0.1,
    sampleEverySeconds = 1,
}) {
    const layout = buildLayout(corridorConfig);
    const engine = new SimulationEngine(layout);

    const arterialModes = {};
    const demand = {};
    for (const arterial of layout.arterials) {
        arterialModes[arterial.id] = controllerMode;
        demand[arterial.id] = arterial.demand.spawnRatePerLanePerMin;
    }
    for (const connector of layout.connectors) {
        demand[connector.id] = connector.demand.spawnRatePerLanePerMin;
    }

    engine.reset({
        seed,
        arterialModes,
        demand,
        sensorMode,
        batteryBackedSensors: true,
        power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 },
    });

    const sampleEveryTicks = Math.max(1, Math.round(sampleEverySeconds / dt));
    const rows = [];
    const sideStreetRows = [];
    let outageStarted = false;
    let outageEnded = false;
    let statsReset = warmupTicks <= 0;

    const totalTicks = warmupTicks + durationTicks;
    for (let tick = 0; tick < totalTicks; tick += 1) {
        const measuredTick = tick - warmupTicks;

        if (!statsReset && measuredTick >= 0) {
            engine.resetStats();
            statsReset = true;
        }

        if (powerOutageStartTick != null && !outageStarted && measuredTick >= powerOutageStartTick) {
            engine.setManualLoadShedding(true);
            outageStarted = true;
        }
        if (powerOutageEndTick != null && outageStarted && !outageEnded && measuredTick >= powerOutageEndTick) {
            engine.setManualLoadShedding(false);
            outageEnded = true;
        }

        engine.tick(dt);

        if (measuredTick >= 0 && measuredTick % sampleEveryTicks === 0) {
            const snap = engine.snapshot();
            for (const arterial of layout.arterials) {
                const s = snap.stats[arterial.id];
                const row = {
                    tick: measuredTick,
                    arterial: arterial.id,
                    avgWaitTime: round(s.avgWaitRolling, 3),
                    throughputPerMin: s.throughputPerMin,
                    clearedTotal: s.clearedTotal,
                    waitSumTotal: s.waitSumTotal,
                    clearedWithoutStopping: s.clearedWithoutStopPct == null ? '' : round(s.clearedWithoutStopPct, 1),
                    powerState: snap.powerState,
                };
                for (const info of engine.nodeInfosByArterial.get(arterial.id) ?? []) {
                    row[`queueLength_${info.node.id}`] = s.queues[info.node.id];
                }
                rows.push(row);
            }

            sideStreetRows.push({
                tick: measuredTick,
                avgWaitTime: round(snap.sideStreet.avgWaitRolling, 3),
                throughputPerMin: snap.sideStreet.throughputPerMin,
                clearedTotal: snap.sideStreet.clearedTotal,
                waitSumTotal: snap.sideStreet.waitSumTotal,
                clearedWithoutStopping:
                    snap.sideStreet.clearedWithoutStopPct == null ? '' : round(snap.sideStreet.clearedWithoutStopPct, 1),
                powerState: snap.powerState,
            });
        }
    }

    const accounting = engine.carAccounting();
    const summary = buildSummary({
        layout,
        engine,
        seed,
        controllerMode,
        sensorMode,
        warmupTicks,
        powerOutageStartTick,
        powerOutageEndTick,
        corridorConfig,
        durationTicks,
        dt,
        rows,
        sideStreetRows,
        accounting,
    });

    return { rows, sideStreetRows, summary };
}

function buildSummary({
    layout,
    engine,
    seed,
    controllerMode,
    sensorMode,
    warmupTicks,
    powerOutageStartTick,
    powerOutageEndTick,
    corridorConfig,
    durationTicks,
    dt,
    rows,
    sideStreetRows,
    accounting,
}) {
    const finalSnap = engine.snapshot();
    const durationSeconds = durationTicks * dt;

    // Full-run average wait/throughput per arterial: a true whole-run rate computed from
    // cumulative counters, NOT `avgWaitRolling`/`throughputPerMin`'s last-60-simulated-second
    // rolling snapshot. That rolling window sits entirely inside the post-outage tail for a
    // load-shedding run, which structurally erases most of the run's real signal-vs-fixed-time
    // difference - see the Phase 2 results-page audit.
    const perArterial = layout.arterials.map((arterial) => {
        const s = finalSnap.stats[arterial.id];
        return {
            id: arterial.id,
            avgWaitTime: s.clearedTotal ? s.waitSumTotal / s.clearedTotal : 0,
            throughputPerMin: s.clearedTotal / (durationSeconds / 60),
            clearedTotal: s.clearedTotal,
            waitSumTotal: s.waitSumTotal,
            clearedWithoutStopTotal: s.clearedWithoutStopTotal,
            pctClearedWithoutStop: s.clearedWithoutStopPct,
        };
    });

    // Arterial scope: aggregated across arterials to match `simulation_runs`'
    // single-scalar-per-run schema (build step 16). Throughput is additive
    // (sum across arterials); wait time and cleared-without-stop % are
    // weighted by each arterial's own cleared count so a busier arterial
    // counts for more, not an unweighted average of two possibly very
    // different sample sizes.
    const clearedTotalArterial = perArterial.reduce((sum, a) => sum + a.clearedTotal, 0);
    const waitSumTotalArterial = perArterial.reduce((sum, a) => sum + a.waitSumTotal, 0);
    const clearedWithoutStopTotalArterial = perArterial.reduce((sum, a) => sum + a.clearedWithoutStopTotal, 0);
    const throughputPerMinArterial = perArterial.reduce((sum, a) => sum + a.throughputPerMin, 0);
    const avgWaitTimeArterial = clearedTotalArterial ? waitSumTotalArterial / clearedTotalArterial : 0;
    const pctClearedWithoutStopArterial = clearedTotalArterial
        ? (clearedWithoutStopTotalArterial / clearedTotalArterial) * 100
        : null;

    // Side-street scope: the engine already keeps one combined bucket across
    // every connector (see engine.js's `sideStreetStats`), so no further
    // aggregation is needed here.
    const sideStreet = finalSnap.sideStreet;
    const avgWaitTimeSideStreet = sideStreet.clearedTotal ? sideStreet.waitSumTotal / sideStreet.clearedTotal : 0;
    const throughputPerMinSideStreet = sideStreet.clearedTotal / (durationSeconds / 60);

    // Total scope: arterial + side-street blended, weighted by each scope's
    // own cleared count - same weighting principle as the arterial-only
    // aggregation above, just one level up.
    const clearedTotal = clearedTotalArterial + sideStreet.clearedTotal;
    const waitSumTotal = waitSumTotalArterial + sideStreet.waitSumTotal;
    const clearedWithoutStopTotal = clearedWithoutStopTotalArterial + sideStreet.clearedWithoutStopTotal;
    const throughputPerMin = throughputPerMinArterial + throughputPerMinSideStreet;
    const avgWaitTime = clearedTotal ? waitSumTotal / clearedTotal : 0;
    const pctClearedWithoutStop = clearedTotal ? (clearedWithoutStopTotal / clearedTotal) * 100 : null;

    const totalCumulativeByTick = buildTotalCumulativeByTick(rows, sideStreetRows);
    const arterialCumulativeByTick = buildCumulativeByTick(rows);
    const sideStreetCumulativeByTick = buildCumulativeByTick(sideStreetRows);
    const arterialByTick = buildByTickThroughput(rows);
    const sideStreetByTick = buildByTickThroughput(sideStreetRows);
    const totalByTick = new Map(arterialByTick);
    for (const [tick, value] of sideStreetByTick) {
        totalByTick.set(tick, (totalByTick.get(tick) ?? 0) + value);
    }

    const arterialWaitByTick = buildByTickWeightedAvgWait([rows]);
    const sideStreetWaitByTick = buildByTickWeightedAvgWait([sideStreetRows]);
    const totalWaitByTick = buildByTickWeightedAvgWait([rows, sideStreetRows]);

    // Pre-outage / during-outage / post-recovery segmented total-scope averages - only
    // meaningful (non-null) for a bounded-outage run. Computed from cumulative counters at
    // the segment boundaries, not from the rolling window, for the same reason as the
    // full-run averages above; this is the only way to see the real, undiluted Adaptive-vs-
    // Fixed-time gap on either side of the outage.
    const segments =
        powerOutageStartTick != null && powerOutageEndTick != null
            ? {
                  preOutage: segmentStats(totalCumulativeByTick, 0, powerOutageStartTick, dt),
                  duringOutage: segmentStats(totalCumulativeByTick, powerOutageStartTick, powerOutageEndTick, dt),
                  postRecovery: segmentStats(
                      totalCumulativeByTick,
                      powerOutageEndTick,
                      durationTicks,
                      dt,
                      { clearedTotal, waitSumTotal }
                  ),
                  preOutageArterial: segmentStats(arterialCumulativeByTick, 0, powerOutageStartTick, dt),
                  duringOutageArterial: segmentStats(arterialCumulativeByTick, powerOutageStartTick, powerOutageEndTick, dt),
                  postRecoveryArterial: segmentStats(
                      arterialCumulativeByTick,
                      powerOutageEndTick,
                      durationTicks,
                      dt,
                      { clearedTotal: clearedTotalArterial, waitSumTotal: waitSumTotalArterial }
                  ),
                  preOutageSideStreet: segmentStats(sideStreetCumulativeByTick, 0, powerOutageStartTick, dt),
                  duringOutageSideStreet: segmentStats(sideStreetCumulativeByTick, powerOutageStartTick, powerOutageEndTick, dt),
                  postRecoverySideStreet: segmentStats(
                      sideStreetCumulativeByTick,
                      powerOutageEndTick,
                      durationTicks,
                      dt,
                      { clearedTotal: sideStreet.clearedTotal, waitSumTotal: sideStreet.waitSumTotal }
                  ),
              }
            : {
                  preOutage: null, duringOutage: null, postRecovery: null,
                  preOutageArterial: null, duringOutageArterial: null, postRecoveryArterial: null,
                  preOutageSideStreet: null, duringOutageSideStreet: null, postRecoverySideStreet: null,
              };

    const waitDistribution = engine.waitDistributionTotal();

    return {
        seed,
        controllerMode,
        powerState: powerOutageStartTick != null ? 'load_shedding' : 'normal',
        sensorMode: controllerMode === 'fixed' ? null : sensorMode, // fixed-time never reads sensors (spec's DB schema note)
        corridorConfig: corridorConfig.id,
        avgWaitTime,
        avgWaitTimeArterial,
        avgWaitTimeSideStreet,
        throughputPerMin,
        throughputPerMinArterial,
        throughputPerMinSideStreet,
        pctClearedWithoutStop,
        pctClearedWithoutStopArterial,
        pctClearedWithoutStopSideStreet: sideStreet.clearedWithoutStopPct,
        medianWait: waitDistribution.medianWait,
        p95Wait: waitDistribution.p95Wait,
        maxWait: waitDistribution.maxWait,
        preOutage: segments.preOutage,
        duringOutage: segments.duringOutage,
        postRecovery: segments.postRecovery,
        preOutageArterial: segments.preOutageArterial,
        duringOutageArterial: segments.duringOutageArterial,
        postRecoveryArterial: segments.postRecoveryArterial,
        preOutageSideStreet: segments.preOutageSideStreet,
        duringOutageSideStreet: segments.duringOutageSideStreet,
        postRecoverySideStreet: segments.postRecoverySideStreet,
        timeToRecoverySeconds: computeRecoverySeconds(totalByTick, powerOutageStartTick, powerOutageEndTick, dt),
        timeToRecoverySecondsArterial: computeRecoverySeconds(arterialByTick, powerOutageStartTick, powerOutageEndTick, dt),
        timeToRecoverySecondsSideStreet: computeRecoverySeconds(sideStreetByTick, powerOutageStartTick, powerOutageEndTick, dt),
        // Wait-time's own recovery time: "lower is better", so recovered means DROPPING back to
        // (rather than climbing up to) within tolerance of the pre-outage baseline. 1.25x
        // mirrors throughput's 0.8x (1 / 0.8 = 1.25) - no data-driven reason to pick a different
        // tolerance for a metric moving in the opposite direction.
        timeToRecoveryWaitSeconds: computeRecoverySeconds(totalWaitByTick, powerOutageStartTick, powerOutageEndTick, dt, {
            thresholdMultiplier: 1.25,
            notRecoveredWhen: (value, threshold) => value > threshold,
        }),
        timeToRecoveryWaitSecondsArterial: computeRecoverySeconds(arterialWaitByTick, powerOutageStartTick, powerOutageEndTick, dt, {
            thresholdMultiplier: 1.25,
            notRecoveredWhen: (value, threshold) => value > threshold,
        }),
        timeToRecoveryWaitSecondsSideStreet: computeRecoverySeconds(sideStreetWaitByTick, powerOutageStartTick, powerOutageEndTick, dt, {
            thresholdMultiplier: 1.25,
            notRecoveredWhen: (value, threshold) => value > threshold,
        }),
        powerOutageStartSeconds: powerOutageStartTick != null ? round(powerOutageStartTick * dt, 1) : null,
        powerOutageEndSeconds: powerOutageEndTick != null ? round(powerOutageEndTick * dt, 1) : null,
        perArterial,
        carAccounting: accounting,
        durationTicks,
        rawConfig: {
            seed,
            controllerMode,
            sensorMode,
            warmupTicks,
            powerOutageStartTick,
            powerOutageEndTick,
            corridorConfig: corridorConfig.id,
            durationTicks,
            dt,
        },
    };
}

export function buildByTickThroughput(rows) {
    const byTick = new Map();
    for (const row of rows) {
        byTick.set(row.tick, (byTick.get(row.tick) ?? 0) + row.throughputPerMin);
    }
    return byTick;
}

/**
 * Per-tick average wait across one or more row groups (e.g. every arterial, or arterial +
 * side-street combined), weighted by each row's own `throughputPerMin` - which, per
 * engine.js's snapshot(), is exactly `recentClears.length`, the same 60s-window car count
 * `avgWaitTime` was itself averaged over. Wait isn't additive like throughput, so a plain
 * sum/mean across arterials would let a near-empty arterial's noisy average count as much as
 * a busy one's; weighting by recent clears fixes that without needing new engine fields.
 */
export function buildByTickWeightedAvgWait(rowGroups) {
    const acc = new Map();
    for (const rows of rowGroups) {
        for (const row of rows) {
            const weight = row.throughputPerMin;
            const entry = acc.get(row.tick) ?? { weightedSum: 0, weightSum: 0 };
            entry.weightedSum += row.avgWaitTime * weight;
            entry.weightSum += weight;
            acc.set(row.tick, entry);
        }
    }

    const byTick = new Map();
    for (const [tick, { weightedSum, weightSum }] of acc) {
        byTick.set(tick, weightSum > 0 ? weightedSum / weightSum : 0);
    }
    return byTick;
}

/** Cumulative {clearedTotal, waitSumTotal} at every sampled tick, summed across one row group. */
function buildCumulativeByTick(rows) {
    const byTick = new Map();
    for (const row of rows) {
        const entry = byTick.get(row.tick) ?? { clearedTotal: 0, waitSumTotal: 0 };
        entry.clearedTotal += row.clearedTotal;
        entry.waitSumTotal += row.waitSumTotal;
        byTick.set(row.tick, entry);
    }
    return byTick;
}

/** Total-scope (arterial + side-street) cumulative {clearedTotal, waitSumTotal} at every sampled tick. */
function buildTotalCumulativeByTick(rows, sideStreetRows) {
    const byTick = buildCumulativeByTick(rows);
    for (const [tick, entry] of buildCumulativeByTick(sideStreetRows)) {
        const existing = byTick.get(tick) ?? { clearedTotal: 0, waitSumTotal: 0 };
        byTick.set(tick, {
            clearedTotal: existing.clearedTotal + entry.clearedTotal,
            waitSumTotal: existing.waitSumTotal + entry.waitSumTotal,
        });
    }
    return byTick;
}

/** Cumulative {clearedTotal, waitSumTotal} as of the latest sampled tick at or before `tick`, or zero before the first sample. */
function cumulativeAtOrBefore(cumulativeByTick, tick) {
    if (tick <= 0) return { clearedTotal: 0, waitSumTotal: 0 };

    let best = null;
    for (const [t, entry] of cumulativeByTick) {
        if (t <= tick && (best === null || t > best.t)) best = { t, entry };
    }
    return best ? best.entry : { clearedTotal: 0, waitSumTotal: 0 };
}

/**
 * True (non-rolling) average wait and throughput over [fromTick, toTick), derived from
 * cumulative counters rather than the engine's 60s rolling window. `finalCumulative`, when
 * given, is used for the `toTick` end instead of a sampled-row lookup - the final engine
 * snapshot's cumulative totals are exact, not just the nearest sample.
 */
function segmentStats(cumulativeByTick, fromTick, toTick, dt, finalCumulative = null) {
    const before = cumulativeAtOrBefore(cumulativeByTick, fromTick);
    const after = finalCumulative ?? cumulativeAtOrBefore(cumulativeByTick, toTick);

    const clearedDelta = after.clearedTotal - before.clearedTotal;
    const waitDelta = after.waitSumTotal - before.waitSumTotal;
    const seconds = (toTick - fromTick) * dt;

    return {
        avgWaitTime: clearedDelta > 0 ? waitDelta / clearedDelta : null,
        throughputPerMin: seconds > 0 ? clearedDelta / (seconds / 60) : null,
        clearedTotal: clearedDelta,
    };
}

/**
 * How far back the trailing smoothing window in computeRecoverySeconds() reaches, in seconds.
 * Matched to this project's demand-fluctuation period (corridor.js's own default, and every
 * shipped corridor JSON's `fluctuationPeriodS`, is 300 - see equations.js's fluctuatingDemand())
 * so the smoothing exactly cancels that cycle's ripple. computeRecoverySeconds() is corridor-
 * agnostic (it only sees byTick, not the corridor config), so this is a hardcoded assumption,
 * not a derived value - revisit it if a corridor with a different fluctuation period ships.
 */
const RECOVERY_SMOOTHING_WINDOW_SECONDS = 300;

/**
 * Recovery time: seconds from power being RESTORED (`powerOutageEndTick`) until an aggregate
 * metric returns to, and then sustains, within tolerance of its own pre-outage baseline for the
 * rest of the run. Returns null for a normal-power run, or if that's never established before
 * the run ends.
 *
 * Generic over metric direction via `notRecoveredWhen`/`thresholdMultiplier`: throughput's
 * default (climb back to >= 80% of baseline) suits a "higher is better" metric; a "lower is
 * better" metric like wait time passes its own options (e.g. drop back to <= 125% of baseline)
 * - see the timeToRecoveryWaitSeconds* call sites below.
 *
 * "Sustains" is checked on a trailing RECOVERY_SMOOTHING_WINDOW_SECONDS-wide rolling average of
 * the metric, not the raw per-tick value, and not a suffix-to-end average either - both of
 * those were tried and both broke:
 *   - Raw per-tick "never dips below threshold again": this corridor's demand fluctuates on a
 *     fixed ~300s cycle, completely independently of the outage, so every controller's raw
 *     throughput legitimately troughs below any fixed threshold every ~150s, forever. That rule
 *     just measures which controller's noisiest dip happens to land latest in the sampled
 *     series - not a real recovery difference - and can inflate an otherwise-fine controller's
 *     number by an order of magnitude (see the results-page audit).
 *   - Suffix-mean-from-T-to-end: for a long post-restore window, a distant healthy tail
 *     mathematically dilutes an early bad patch enough to satisfy the threshold from T=0, so it
 *     reports "recovered instantly" even when the system was clearly still struggling right
 *     after restore.
 * A fixed-width trailing window avoids both: it's wide enough (one full demand cycle) to average
 * out the harmless cyclic ripple, but bounded, so a distant future tail can't retroactively
 * paper over how bad things were near T - the smoothed value at each point only reflects the
 * recent past. Scanning for the LAST point that trailing average dips below threshold, and
 * reporting the point right after it, means a real, sustained relapse (a demand-cycle peak
 * coinciding with the post-restore window, or an actual outage-driven second surge) still
 * correctly pushes the reported time out, while brief single-sample noise no longer can.
 *
 * Unlike the old permanent-outage build, power actually comes back on here, so this now
 * measures exactly what the dashboard copy says it does ("time to return to normal flow once
 * power is restored") rather than self-stabilization under a permanent all-way-stop fallback.
 */
function computeRecoverySeconds(
    byTick,
    powerOutageStartTick,
    powerOutageEndTick,
    dt,
    { thresholdMultiplier = 0.8, notRecoveredWhen = (value, threshold) => value < threshold } = {}
) {
    if (powerOutageStartTick == null || powerOutageEndTick == null) return null;

    const ticks = [...byTick.keys()].sort((a, b) => a - b);

    const preOutageTicks = ticks.filter((t) => t < powerOutageStartTick);
    if (!preOutageTicks.length) return null;
    const baseline = preOutageTicks.reduce((sum, t) => sum + byTick.get(t), 0) / preOutageTicks.length;
    const threshold = baseline * thresholdMultiplier;

    const postRestoreTicks = ticks.filter((t) => t >= powerOutageEndTick);
    const n = postRestoreTicks.length;
    if (!n) return null;

    // Trailing rolling average via two pointers: smoothed[i] = mean of samples with tick in
    // (tick_i - windowTicks, tick_i]. Deliberately trailing, not forward or centered - a forward
    // window shrinks to a single (raw, noise-sensitive) sample right at the array's end, which
    // is exactly the region this needs to be MOST stable in.
    const windowTicks = RECOVERY_SMOOTHING_WINDOW_SECONDS / dt;
    const smoothed = new Array(n);
    let windowStart = 0;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i += 1) {
        sum += byTick.get(postRestoreTicks[i]);
        count += 1;
        while (postRestoreTicks[i] - postRestoreTicks[windowStart] > windowTicks) {
            sum -= byTick.get(postRestoreTicks[windowStart]);
            count -= 1;
            windowStart += 1;
        }
        smoothed[i] = sum / count;
    }

    let lastBelowIndex = -1;
    smoothed.forEach((value, i) => {
        if (notRecoveredWhen(value, threshold)) lastBelowIndex = i;
    });
    if (lastBelowIndex === n - 1) return null; // never sustains recovery through run end

    const recoveredTick = postRestoreTicks[lastBelowIndex + 1];
    return round((recoveredTick - powerOutageEndTick) * dt, 1);
}

function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}
