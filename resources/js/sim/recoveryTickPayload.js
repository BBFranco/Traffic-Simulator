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
 * Folds one rep's per-tick `rows`/`sideStreetRows` into a running accumulator across every rep
 * of a (controller_mode, sensor_mode) condition. Pass `acc` back in on the next call; pass
 * `undefined`/`null` to start a fresh one. Call finalizeRecoveryTickPayload() once every rep is in.
 */
export function accumulateRecoveryTicks(acc, { rows, sideStreetRows }) {
    acc ??= {
        throughputArterialSum: new Map(),
        waitArterialSum: new Map(),
        arterialRowCount: new Map(),
        throughputSideStreetSum: new Map(),
        waitSideStreetSum: new Map(),
        reps: 0,
    };

    for (const row of rows) {
        acc.throughputArterialSum.set(row.tick, (acc.throughputArterialSum.get(row.tick) ?? 0) + row.throughputPerMin);
        acc.waitArterialSum.set(row.tick, (acc.waitArterialSum.get(row.tick) ?? 0) + row.avgWaitTime);
        acc.arterialRowCount.set(row.tick, (acc.arterialRowCount.get(row.tick) ?? 0) + 1);
    }
    for (const row of sideStreetRows) {
        acc.throughputSideStreetSum.set(row.tick, (acc.throughputSideStreetSum.get(row.tick) ?? 0) + row.throughputPerMin);
        acc.waitSideStreetSum.set(row.tick, (acc.waitSideStreetSum.get(row.tick) ?? 0) + row.avgWaitTime);
    }
    acc.reps += 1;

    return acc;
}

/** Averages an accumulator built by accumulateRecoveryTicks() into the `POST /api/recovery-ticks` payload shape. */
export function finalizeRecoveryTickPayload(
    acc,
    { controllerMode, sensorMode, corridorId, dt, powerOutageStartTick, powerOutageEndTick }
) {
    const ticks = downsample([...acc.throughputArterialSum.keys()].sort((a, b) => a - b), MAX_CHART_POINTS);

    return {
        controller_mode: controllerMode,
        // fixed-time and green-wave never vary by sensor (matches simulation_runs' own column).
        sensor_mode: controllerMode === 'adaptive' ? sensorMode : null,
        corridor_config: corridorId,
        power_event_seconds: round(powerOutageStartTick * dt, 1),
        power_outage_end_seconds: round(powerOutageEndTick * dt, 1),
        ticks: ticks.map((tick) => {
            const throughputArterial = acc.throughputArterialSum.get(tick) / acc.reps;
            const waitArterial = acc.waitArterialSum.get(tick) / acc.arterialRowCount.get(tick);
            const throughputSideStreet = (acc.throughputSideStreetSum.get(tick) ?? 0) / acc.reps;
            const waitSideStreet = (acc.waitSideStreetSum.get(tick) ?? 0) / acc.reps;

            return {
                tick,
                seconds: round(tick * dt, 1),
                throughput_per_min: round(throughputArterial + throughputSideStreet, 1),
                throughput_per_min_arterial: round(throughputArterial, 1),
                throughput_per_min_side_street: round(throughputSideStreet, 1),
                avg_wait_time: round((waitArterial + waitSideStreet) / 2, 1),
                avg_wait_time_arterial: round(waitArterial, 1),
                avg_wait_time_side_street: round(waitSideStreet, 1),
            };
        }),
    };
}

function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}
