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
        // Total-scope only (see runHeadless.js's buildSummary) - null on a normal-power run.
        avg_wait_time_pre_outage: summary.preOutage?.avgWaitTime ?? null,
        avg_wait_time_during_outage: summary.duringOutage?.avgWaitTime ?? null,
        avg_wait_time_post_recovery: summary.postRecovery?.avgWaitTime ?? null,
        throughput_per_min_pre_outage: summary.preOutage?.throughputPerMin ?? null,
        throughput_per_min_during_outage: summary.duringOutage?.throughputPerMin ?? null,
        throughput_per_min_post_recovery: summary.postRecovery?.throughputPerMin ?? null,
        // Full-run, network-wide distribution - a mean alone can't tell "everyone waits a
        // bit longer" apart from "most people are fine, a few are stranded".
        median_wait_time: summary.medianWait,
        p95_wait_time: summary.p95Wait,
        max_wait_time: summary.maxWait,
        raw_config_json: summary.rawConfig,
    };
}
