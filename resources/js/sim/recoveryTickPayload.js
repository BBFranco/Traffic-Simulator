/**
 * recoveryTickPayload.js - maps runHeadless()'s per-tick `rows` (one row per
 * arterial per sample) and `sideStreetRows` (one combined side-street row per
 * sample) to the payload shape `POST /api/recovery-ticks` validates and
 * stores: (tick, throughput_per_min, avg_wait_time) series for the Total,
 * Main Arterial, and Side Streets scopes. Throughput is summed across
 * arterials (and, for the total, across arterials + side streets), same as
 * buildSummary()'s corridor-wide throughputPerMin in runHeadless.js (additive,
 * not averaged); wait time is averaged unweighted (across arterials for the
 * arterial scope, and between the arterial and side-street averages for the
 * total scope). Shared by the CLI batch driver and the /results page's
 * batch-run button - only call this for a load-shedding condition's rep 0,
 * the one representative run whose curve backs the recovery charts.
 */
/**
 * Chart-point cap: the recovery line charts don't benefit from more points than this (a 60s
 * rolling-window metric can't meaningfully change faster than that anyway), but a full-resolution
 * series at the longer post-warm-up run durations (thousands of samples) was slow enough for
 * Laravel's per-field wildcard validation on `POST /api/recovery-ticks` to blow past PHP's 30s
 * execution limit - which, since the batch-run button awaits that POST, killed the entire
 * 360-run batch the first time it hit a load-shedding condition. Segment-stat accuracy
 * (pre/during/post-outage) is untouched by this - those are computed separately in
 * runHeadless.js from the full-resolution `rows`, not from this downsampled series.
 */
const MAX_CHART_POINTS = 300;

function downsample(sortedTicks, maxPoints) {
    if (sortedTicks.length <= maxPoints) return sortedTicks;

    const step = (sortedTicks.length - 1) / (maxPoints - 1);
    const picked = new Set();
    for (let i = 0; i < maxPoints; i += 1) {
        picked.add(sortedTicks[Math.round(i * step)]);
    }
    return [...picked];
}

export function buildRecoveryTickPayload({
    controllerMode,
    sensorMode,
    rows,
    sideStreetRows,
    dt,
    powerOutageStartTick,
    powerOutageEndTick,
}) {
    const throughputSums = new Map();
    const waitSums = new Map();
    const counts = new Map();
    for (const row of rows) {
        throughputSums.set(row.tick, (throughputSums.get(row.tick) ?? 0) + row.throughputPerMin);
        waitSums.set(row.tick, (waitSums.get(row.tick) ?? 0) + row.avgWaitTime);
        counts.set(row.tick, (counts.get(row.tick) ?? 0) + 1);
    }

    const sideStreetByTick = new Map(sideStreetRows.map((row) => [row.tick, row]));

    const ticks = downsample([...throughputSums.keys()].sort((a, b) => a - b), MAX_CHART_POINTS);

    return {
        controller_mode: controllerMode,
        // fixed-time and green-wave never vary by sensor (matches simulation_runs' own column).
        sensor_mode: controllerMode === 'adaptive' ? sensorMode : null,
        power_event_seconds: round(powerOutageStartTick * dt, 1),
        power_outage_end_seconds: round(powerOutageEndTick * dt, 1),
        ticks: ticks.map((tick) => {
            const throughputArterial = throughputSums.get(tick);
            const waitArterial = waitSums.get(tick) / counts.get(tick);
            const sideStreet = sideStreetByTick.get(tick) ?? { throughputPerMin: 0, avgWaitTime: 0 };

            return {
                tick,
                seconds: round(tick * dt, 1),
                throughput_per_min: round(throughputArterial + sideStreet.throughputPerMin, 1),
                throughput_per_min_arterial: round(throughputArterial, 1),
                throughput_per_min_side_street: round(sideStreet.throughputPerMin, 1),
                avg_wait_time: round((waitArterial + sideStreet.avgWaitTime) / 2, 1),
                avg_wait_time_arterial: round(waitArterial, 1),
                avg_wait_time_side_street: round(sideStreet.avgWaitTime, 1),
            };
        }),
    };
}

function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}
