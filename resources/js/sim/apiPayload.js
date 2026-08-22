/**
 * apiPayload.js - maps a runHeadless() summary (camelCase) to the payload
 * shape `POST /api/simulation-runs` (build step 16) validates and stores
 * (snake_case, matching the `simulation_runs` migration columns exactly).
 * Shared by the CLI batch driver and the /results page's batch-run button.
 */
export function toApiPayload(summary) {
    return {
        seed: summary.seed,
        controller_mode: summary.controllerMode,
        power_state: summary.powerState,
        sensor_mode: summary.sensorMode,
        corridor_config: summary.corridorConfig,
        avg_wait_time: summary.avgWaitTime,
        throughput_per_min: summary.throughputPerMin,
        // The column isn't nullable (unlike sensor_mode/time_to_recovery_seconds,
        // which the spec explicitly marks nullable) - a run where nothing
        // cleared yet reports 0%, not null.
        pct_cleared_without_stop: summary.pctClearedWithoutStop ?? 0,
        time_to_recovery_seconds: summary.timeToRecoverySeconds,
        raw_config_json: summary.rawConfig,
    };
}
