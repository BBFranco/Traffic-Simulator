/**
 * experimentalMatrix.js - the dissertation's experimental matrix
 * (controller mode x power state x sensor mode), shared by the CLI batch
 * driver (batch/runBatch.mjs, build step 13) and the /results page's
 * batch-run button (build step 17) so the two never drift apart.
 *
 * Fixed-time and green wave don't vary by sensor (fixed-time never reads one;
 * green wave times off distance/speed, not a sensed queue), so only the two
 * actuated modes - adaptive and coordinated adaptive - are tested against all
 * four real sensor modes:
 *   3 power states x (1 fixed + 1 green wave + 4 adaptive + 4 coordinated adaptive) = 30 conditions.
 * The power states: normal, load_shedding (the total blackout - every junction dark) and rolling_blackout
 * (batchSchedule.js's ROLLING_SCHEDULE - zone by zone).
 *
 * Plus RQ2's richness test (2026-10-22), appended after the main matrix: adaptive_rich - the same adaptive controller
 * and field sensors, but calls may come early from a sensor's count or advance-zone queue (demandEstimator.js's
 * richCallSufficient()) - for the three sensors that report more than presence, at normal power and the total
 * blackout: 6 conditions, so 36 in all. The loop is left out: presence is all it reports, so under that rule it is
 * the plain adaptive loop run by construction. Each pairs by seed with the same sensor's plain adaptive run.
 */
export const RICH_SENSOR_MODES = ['radar', 'camera', 'magnetometer'];
export const RICH_POWER_STATES = ['normal', 'load_shedding'];

export const POWER_STATES = ['normal', 'load_shedding', 'rolling_blackout'];
export const SENSOR_MODES = ['inductive_loop', 'radar', 'camera', 'magnetometer'];

export function buildExperimentalMatrix() {
    const conditions = [];
    for (const powerState of POWER_STATES) {
        conditions.push({ key: `fixed_${powerState}`, controllerMode: 'fixed', sensorMode: 'inductive_loop', powerState });
        conditions.push({ key: `green_wave_${powerState}`, controllerMode: 'green_wave', sensorMode: 'inductive_loop', powerState });
        for (const sensorMode of SENSOR_MODES) {
            conditions.push({ key: `adaptive_${powerState}_${sensorMode}`, controllerMode: 'adaptive', sensorMode, powerState });
        }
        for (const sensorMode of SENSOR_MODES) {
            conditions.push({ key: `coordinated_adaptive_${powerState}_${sensorMode}`, controllerMode: 'coordinated_adaptive', sensorMode, powerState });
        }
    }
    for (const powerState of RICH_POWER_STATES) {
        for (const sensorMode of RICH_SENSOR_MODES) {
            conditions.push({ key: `adaptive_rich_${powerState}_${sensorMode}`, controllerMode: 'adaptive_rich', sensorMode, powerState });
        }
    }
    return conditions;
}

/**
 * Seed for rep `rep` (0-indexed) of a given power state, SHARED across every
 * controller mode/sensor combination at that power state - not per-condition.
 * This is what makes the results page's "paired comparison...on the same
 * seeds" claim (and the offline Python paired t-test/Wilcoxon, build step 20)
 * actually valid: fixed-time's rep 5 and adaptive's rep 5 under normal power
 * see the exact same arrival sequence, so a difference in their metrics is
 * attributable to the controller, not to which random seed each happened to
 * draw.
 *
 * One seed set for every power state (2026-10-16): rep 5 at normal power, in the total blackout and in the rolling
 * blackout sees the same arrivals too, so the power states compare on the same traffic. Until then the total blackout
 * ran on base + 10000 + rep - batches from before this used that set. `powerState` stays in the signature so a later
 * per-state set needs no caller changes.
 */
export function seedForRep(baseSeed, powerState, rep) {
    return baseSeed + rep;
}
