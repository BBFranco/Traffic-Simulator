/**
 * warmupProbe.js - measures a corridor's warm-up before a batch runs, instead
 * of reusing one asserted constant for every corridor. The 3600 ticks (360 s)
 * tuned on the small Pretorius / Francis Baard corridor are far too short for
 * the 54-junction network, whose fixed-time and green-wave waits take tens of
 * minutes to level off from an empty start.
 *
 * Shared by batch/runBatch.mjs and the /results page's batch button (through
 * sim/batchWorker.js), so both pick the warm-up the same way.
 *
 * PROBE_REPLICATIONS long normal-power runs per controller, from empty
 * (warmupTicks: 0), on the batch's own first normal-power seeds, averaged
 * tick by tick (Welch's method - one run's noise made the cut jump between
 * 5 and 55 minutes for curves that looked alike). plateau.js finds where
 * each scope's (Total/Arterial/Side-Streets) averaged wait levels off, and
 * the batch warm-up is the slowest of those x WARMUP_SAFETY_MARGIN. Normal power only:
 * the outage lands inside the measured window, so the warm-up only has to get
 * the network to its pre-outage steady state. Adaptive is probed on the
 * inductive loop only - it's the fastest to settle on every sensor.
 *
 * If any probe never levels off (a queue growing for the whole run - the
 * network is oversaturated for that controller), there is no correct
 * warm-up: the batch uses the cap and is flagged not stationary, so its
 * results are read as "still loading up", not as a steady-state comparison.
 */
import { runHeadless, buildByTickWeightedAvgWait } from './runHeadless.js';
import { detectPlateau } from './plateau.js';

/** 2 simulated hours per probe run - long enough to see the slowest (green wave) ramp end and check the level after it. */
export const PROBE_DURATION_TICKS = 72000;
/** Runs averaged per controller. */
export const PROBE_REPLICATIONS = 3;
/** The chosen warm-up never goes below the old constant - the small corridors were checked at it. */
export const MIN_WARMUP_TICKS = 3600;
/** plateau.js only searches the first half of a run for its cut, so that's also the most the probe can ever justify. */
export const MAX_WARMUP_TICKS = PROBE_DURATION_TICKS / 2;
/** Cushion on the slowest measured levelling-off point - a margin, not itself measured. */
export const WARMUP_SAFETY_MARGIN = 1.5;
/** Rounded up to whole simulated minutes at dt = 0.1 s. */
const WARMUP_ROUNDING_TICKS = 600;

/** The runs a probe makes: one per controller, normal power. */
export function probeConditions() {
    return [
        { controllerMode: 'fixed', sensorMode: 'inductive_loop' },
        { controllerMode: 'green_wave', sensorMode: 'inductive_loop' },
        { controllerMode: 'adaptive', sensorMode: 'inductive_loop' },
    ];
}

/** Tick-by-tick mean of several runs' `Map(tick -> value)` series, over the runs that have a value at that tick. */
function averageSeries(seriesList) {
    const sums = new Map();
    for (const byTick of seriesList) {
        for (const [tick, value] of byTick) {
            const entry = sums.get(tick) ?? { sum: 0, n: 0 };
            entry.sum += value;
            entry.n += 1;
            sums.set(tick, entry);
        }
    }
    return [...sums.entries()].map(([tick, { sum, n }]) => ({ tick, value: sum / n }));
}

/**
 * One probe run from empty: each scope's per-tick average wait, as
 * `Map(tick -> value)`. A task of its own so a worker pool can run a probe's
 * seeds side by side (results.js); probeVerdict() combines them.
 */
export function probeSeries({ corridorConfig, controllerMode, sensorMode, seed, dt, durationTicks = PROBE_DURATION_TICKS, routingMode = null }) {
    const { sideStreetRows, totalRows, arterialScopeRows } = runHeadless({
        seed,
        controllerMode,
        sensorMode,
        warmupTicks: 0,
        powerOutageStartTick: null,
        powerOutageEndTick: null,
        corridorConfig,
        durationTicks,
        dt,
        routingMode,
    });
    return {
        total: buildByTickWeightedAvgWait([totalRows]),
        arterial: buildByTickWeightedAvgWait([arterialScopeRows]),
        sideStreet: buildByTickWeightedAvgWait([sideStreetRows]),
    };
}

/**
 * One controller's verdict from its probe runs (probeSeries() results, in
 * seed order): the runs averaged, then where each scope's average wait
 * levels off and whether it then holds steady over `measuredTicks` (the
 * batch runs' measured window).
 */
export function probeVerdict({ controllerMode, sensorMode, runs, dt, measuredTicks }) {
    const scopes = {};
    for (const scope of ['total', 'arterial', 'sideStreet']) {
        const samples = averageSeries(runs.map((run) => run[scope]));
        // Drift only matters over what a batch run actually measures after its warm-up.
        const { convergedAtTick, truncationTick, stationary, driftRatio } = detectPlateau(samples, { dt, horizonSeconds: measuredTicks * dt });
        scopes[scope] = { convergedAtTick, truncationTick, stationary, driftRatio };
    }
    return { controllerMode, sensorMode, scopes };
}

/** One controller's whole probe, one seed after another (the CLI batch). */
export function probeCondition({ corridorConfig, controllerMode, sensorMode, seeds, dt, measuredTicks, durationTicks = PROBE_DURATION_TICKS, routingMode = null }) {
    const runs = seeds.map((seed) => probeSeries({ corridorConfig, controllerMode, sensorMode, seed, dt, durationTicks, routingMode }));
    return probeVerdict({ controllerMode, sensorMode, runs, dt, measuredTicks });
}

/**
 * The batch warm-up from every probe run's verdicts. A scope with no side
 * streets carries no traffic to settle, so an empty series doesn't count
 * against stationarity.
 */
export function chooseWarmup(probes) {
    const verdicts = probes.flatMap((probe) => Object.values(probe.scopes)).filter((scope) => scope.truncationTick != null);
    const stationary = verdicts.length > 0 && verdicts.every((scope) => scope.stationary);
    if (!stationary) return { warmupTicks: MAX_WARMUP_TICKS, stationary: false, probes };

    const slowest = Math.max(...verdicts.map((scope) => scope.convergedAtTick));
    const padded = Math.ceil((slowest * WARMUP_SAFETY_MARGIN) / WARMUP_ROUNDING_TICKS) * WARMUP_ROUNDING_TICKS;
    return { warmupTicks: Math.min(MAX_WARMUP_TICKS, Math.max(MIN_WARMUP_TICKS, padded)), stationary: true, probes };
}
