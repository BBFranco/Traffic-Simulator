/**
 * recoveryTickPayload.js - maps runHeadless()'s per-tick `rows` (one row per
 * arterial per sample) and `sideStreetRows` (one combined side-street row per
 * sample) to the payload shape `POST /api/recovery-ticks` validates and
 * stores: (tick, throughput_per_min, avg_wait_time) series for the Total,
 * Main Arterial, and Side Streets scopes.
 *
 * The recovery-timeline chart needs to agree with the "time to recovery"
 * stat card, which averages across every rep of a condition (n=30, n=120,
 * ...) - a single representative run's curve doesn't track that average and
 * can visibly disagree with it (see the results-page audit). So this now
 * accumulates every load-shedding rep of a (controller_mode, sensor_mode)
 * condition via accumulateRecoveryTicks(), and finalizeRecoveryTickPayload()
 * averages them into one curve at the end - same population the "time to
 * recovery" aggregate is drawn from. Throughput stays additive across
 * arterials within a rep (summed, matching buildSummary()'s corridor-wide
 * throughputPerMin in runHeadless.js), then that per-rep total is averaged
 * across reps; wait time is averaged unweighted across arterials and reps
 * together (equivalent since every rep has the same arterial count).
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

/**
 * Folds one rep's per-tick scope series - `totalRows`, `arterialScopeRows`, `sideStreetRows`
 * (runHeadless()), one row per sampled tick each - into a running accumulator across every rep of
 * a (controller_mode, sensor_mode) condition. Pass `acc` back in on the next call; pass
 * `undefined`/`null` to start a fresh one. Call finalizeRecoveryTickPayload() once every rep is in.
 */
export function accumulateRecoveryTicks(acc, { totalRows, arterialScopeRows, sideStreetRows }) {
    acc ??= { total: new Map(), arterial: new Map(), sideStreet: new Map(), reps: 0 };
    const add = (byTick, rows) => {
        for (const row of rows) {
            const entry = byTick.get(row.tick) ?? { throughput: 0, wait: 0 };
            entry.throughput += row.throughputPerMin;
            entry.wait += row.avgWaitTime;
            byTick.set(row.tick, entry);
        }
    };
    add(acc.total, totalRows);
    add(acc.arterial, arterialScopeRows);
    add(acc.sideStreet, sideStreetRows);
    acc.reps += 1;
    return acc;
}

/** Averages an accumulator built by accumulateRecoveryTicks() into the `POST /api/recovery-ticks` payload shape. */
export function finalizeRecoveryTickPayload(
    acc,
    { controllerMode, sensorMode, corridorId, dt, powerOutageStartTick, powerOutageEndTick, routingMode = 'random' }
) {
    const ticks = downsample([...acc.total.keys()].sort((a, b) => a - b), MAX_CHART_POINTS);
    const mean = (byTick, tick, field) => (byTick.get(tick)?.[field] ?? 0) / acc.reps;

    return {
        controller_mode: controllerMode,
        // fixed-time and green-wave never vary by sensor (matches simulation_runs' own column).
        sensor_mode: controllerMode === 'adaptive' ? sensorMode : null,
        corridor_config: corridorId,
        routing_mode: routingMode,
        power_event_seconds: round(powerOutageStartTick * dt, 1),
        power_outage_end_seconds: round(powerOutageEndTick * dt, 1),
        ticks: ticks.map((tick) => ({
            tick,
            seconds: round(tick * dt, 1),
            throughput_per_min: round(mean(acc.total, tick, 'throughput'), 1),
            throughput_per_min_arterial: round(mean(acc.arterial, tick, 'throughput'), 1),
            throughput_per_min_side_street: round(mean(acc.sideStreet, tick, 'throughput'), 1),
            avg_wait_time: round(mean(acc.total, tick, 'wait'), 1),
            avg_wait_time_arterial: round(mean(acc.arterial, tick, 'wait'), 1),
            avg_wait_time_side_street: round(mean(acc.sideStreet, tick, 'wait'), 1),
        })),
    };
}

function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}
