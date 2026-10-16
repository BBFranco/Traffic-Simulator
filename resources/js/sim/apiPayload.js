/**
 * apiPayload.js - maps a runHeadless() summary (camelCase) to the payload
 * shape `POST /api/simulation-runs` (build step 16) validates and stores
 * (snake_case, matching the `simulation_runs` migration columns exactly).
 * Shared by the CLI batch driver and the /results page's batch-run button.
 */
/**
 * `warmupStationary`: the batch's warm-up probe verdict (sim/warmupProbe.js), null when the warm-up was hand-picked.
 * `warmupDrifting`: the probe's controllers that never levelled off, with each scope's drift (%) - empty when stationary.
 * `warmupSettle`: per probed controller, the tick each scope's wait levelled off at (null: never) - kept in raw_config_json.
 * `batchStartedAt`: when the batch was launched (ISO-8601), so /results can show how long it took.
 * `build`: `{ commit, dirty, source }` of the code that ran the batch.
 * `batchKind`: 'main' (the dataset Results shows) or 'sensitivity' (an appendix batch).
 */
export function toApiPayload(summary, batchId, { warmupStationary = null, warmupDrifting = null, warmupSettle = null, batchStartedAt = null, build = null, batchKind = 'main' } = {}) {
    return {
        batch_id: batchId,
        batch_started_at: batchStartedAt,
        warmup_ticks: summary.rawConfig.warmupTicks,
        warmup_stationary: warmupStationary,
        warmup_drifting: warmupDrifting,
        seed: summary.seed,
        controller_mode: summary.controllerMode,
        routing_mode: summary.routingMode ?? 'random',
        // 'sensitivity' batches never become the batch Results shows - they feed the report's appendix.
        batch_kind: batchKind,
        power_state: summary.powerState,
        sensor_mode: summary.sensorMode,
        // The sensor configuration the run resolved to (sensorSpecs.js) - null for controllers that read no sensors.
        sensor_spec_set: summary.sensorSpec?.set ?? null,
        sensor_spec_hash: summary.sensorSpec?.hash ?? null,
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
        time_to_recovery_wait_seconds: summary.timeToRecoveryWaitSeconds,
        time_to_recovery_wait_seconds_arterial: summary.timeToRecoveryWaitSecondsArterial,
        time_to_recovery_wait_seconds_side_street: summary.timeToRecoveryWaitSecondsSideStreet,
        // Null on a normal-power run (nothing to segment).
        avg_wait_time_pre_outage: summary.preOutage?.avgWaitTime ?? null,
        avg_wait_time_during_outage: summary.duringOutage?.avgWaitTime ?? null,
        avg_wait_time_post_recovery: summary.postRecovery?.avgWaitTime ?? null,
        throughput_per_min_pre_outage: summary.preOutage?.throughputPerMin ?? null,
        throughput_per_min_during_outage: summary.duringOutage?.throughputPerMin ?? null,
        throughput_per_min_post_recovery: summary.postRecovery?.throughputPerMin ?? null,
        avg_wait_time_pre_outage_arterial: summary.preOutageArterial?.avgWaitTime ?? null,
        avg_wait_time_during_outage_arterial: summary.duringOutageArterial?.avgWaitTime ?? null,
        avg_wait_time_post_recovery_arterial: summary.postRecoveryArterial?.avgWaitTime ?? null,
        throughput_per_min_pre_outage_arterial: summary.preOutageArterial?.throughputPerMin ?? null,
        throughput_per_min_during_outage_arterial: summary.duringOutageArterial?.throughputPerMin ?? null,
        throughput_per_min_post_recovery_arterial: summary.postRecoveryArterial?.throughputPerMin ?? null,
        avg_wait_time_pre_outage_side_street: summary.preOutageSideStreet?.avgWaitTime ?? null,
        avg_wait_time_during_outage_side_street: summary.duringOutageSideStreet?.avgWaitTime ?? null,
        avg_wait_time_post_recovery_side_street: summary.postRecoverySideStreet?.avgWaitTime ?? null,
        throughput_per_min_pre_outage_side_street: summary.preOutageSideStreet?.throughputPerMin ?? null,
        throughput_per_min_during_outage_side_street: summary.duringOutageSideStreet?.throughputPerMin ?? null,
        throughput_per_min_post_recovery_side_street: summary.postRecoverySideStreet?.throughputPerMin ?? null,
        // Rolling blackout only (null otherwise): its two stages, splitting "during" - zones 1+3 dark, then zone 2.
        ...Object.fromEntries(['stage1', 'stage2'].flatMap((stage) => [
            [`avg_wait_time_${stage}`, summary[stage]?.avgWaitTime ?? null],
            [`throughput_per_min_${stage}`, summary[stage]?.throughputPerMin ?? null],
            [`avg_wait_time_${stage}_arterial`, summary[`${stage}Arterial`]?.avgWaitTime ?? null],
            [`throughput_per_min_${stage}_arterial`, summary[`${stage}Arterial`]?.throughputPerMin ?? null],
            [`avg_wait_time_${stage}_side_street`, summary[`${stage}SideStreet`]?.avgWaitTime ?? null],
            [`throughput_per_min_${stage}_side_street`, summary[`${stage}SideStreet`]?.throughputPerMin ?? null],
        ])),
        // Full-run, network-wide distribution - a mean alone can't tell "everyone waits a
        // bit longer" apart from "most people are fine, a few are stranded".
        median_wait_time: summary.medianWait,
        p95_wait_time: summary.p95Wait,
        max_wait_time: summary.maxWait,
        p95_wait_time_arterial: summary.p95WaitArterial ?? null,
        max_wait_time_arterial: summary.maxWaitArterial ?? null,
        p95_wait_time_side_street: summary.p95WaitSideStreet ?? null,
        max_wait_time_side_street: summary.maxWaitSideStreet ?? null,
        coordination_stats: summary.coordination ?? null,
        road_waits: summary.roadWaits ?? null,
        // Per rolling-blackout zone (runHeadless.js's zoneSummary()) - every power state, so normal rows give the zone baselines.
        zone_stats: summary.zoneStats ?? null,
        // Destination routing only (null under random turning): trips, their delay over free flow, and what didn't go to plan.
        trips: summary.routing?.trips ?? null,
        mean_trip_time: summary.routing?.meanTripS ?? null,
        mean_trip_delay: summary.routing?.meanTripDelayS ?? null,
        pulled_off: summary.routing?.pulledOff ?? null,
        missed_turns: summary.routing?.missedTurns ?? null,
        missed_driveways: summary.routing?.missedDriveways ?? null,
        diversion_pct: summary.routing?.divertedPct ?? null,
        routing_stats: summary.routing ?? null,
        // Demand lost at full map-edge entries, and roundabout overruns (should be 0) - over the measured window.
        diagnostics: summary.diagnostics ?? null,
        // `build`: the code the batch ran (git commit, dirty tree) - see batch/buildStamp.mjs and vite.config.js.
        raw_config_json: { ...summary.rawConfig, build, warmupSettle },
    };
}
