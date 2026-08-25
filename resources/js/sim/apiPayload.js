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
        avg_wait_time_arterial: summary.avgWaitTimeArterial,
        avg_wait_time_side_street: summary.avgWaitTimeSideStreet,
        throughput_per_min: summary.throughputPerMin,
        throughput_per_min_arterial: summary.throughputPerMinArterial,
        throughput_per_min_side_street: summary.throughputPerMinSideStreet,
        // These columns aren't nullable (unlike sensor_mode/time_to_recovery_seconds,
        // which the spec explicitly marks nullable) - a run where nothing
        // cleared yet reports 0%, not null.
        pct_cleared_without_stop: summary.pctClearedWithoutStop ?? 0,
        pct_cleared_without_stop_arterial: summary.pctClearedWithoutStopArterial ?? 0,
        pct_cleared_without_stop_side_street: summary.pctClearedWithoutStopSideStreet ?? 0,
        time_to_recovery_seconds: summary.timeToRecoverySeconds,
        time_to_recovery_seconds_arterial: summary.timeToRecoverySecondsArterial,
        time_to_recovery_seconds_side_street: summary.timeToRecoverySecondsSideStreet,
        raw_config_json: summary.rawConfig,
    };
}
