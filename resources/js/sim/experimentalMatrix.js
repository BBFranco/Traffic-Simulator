/**
 * experimentalMatrix.js - the dissertation's 12-condition experimental matrix
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
 */
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
 * draw. A rolling blackout runs on the normal-power seeds; the total blackout keeps its own offset set.
 */
export function seedForRep(baseSeed, powerState, rep) {
    const powerOffset = powerState === 'load_shedding' ? 10_000 : 0;
    return baseSeed + powerOffset + rep;
}
