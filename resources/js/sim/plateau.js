/**
 * plateau.js - detects when a time series has settled into a steady state,
 * so warm-up length can be a measured answer instead of an asserted constant
 * (see batch/warmupDiagnostics.mjs, and the results-page scope-filter audit's
 * concern that arterial-only traffic might take longer to equilibrate than
 * the combined Total, making a "worse arterial baseline" reading potentially
 * just an artifact of too-short warm-up).
 *
 * Deliberately generic over the underlying metric - it only sees
 * `{tick, value}` pairs, not what kind of value they are - so it works the
 * same way for wait time, throughput, or anything else sampled per tick.
 *
 * Convergence test: for a candidate tick, split every remaining window mean
 * into an early half and a late half and compare their averages - if they're
 * within tolerance, there's no more systematic drift from that point on,
 * only noise. This (rather than comparing each window to just the one before
 * it) is deliberate: this project's per-tick wait time is naturally noisy
 * even once fully settled (30s windows over a modest car count aren't a huge
 * sample), so a pairwise adjacent-window comparison flags that ordinary
 * settled-state noise as "still converging" almost everywhere - averaging
 * several windows on each side cancels that noise while staying sensitive to
 * a genuine trend.
 */

/**
 * @param samples time-ordered `[{tick, value}]` - gaps in `tick` are fine, only order matters
 * @param windowSeconds width of the non-overlapping window each mean is computed over, in sim
 *        seconds. Matched to RECOVERY_SMOOTHING_WINDOW_SECONDS's reasoning in runHeadless.js by
 *        default (300s, one full demand-fluctuation cycle) so the same cyclic ripple that
 *        motivated that window doesn't get mistaken for "still converging" here.
 * @param toleranceRatio how much the early-half and late-half window averages (from a candidate
 *        point onward) may differ, as a fraction of the early-half average, and still count as
 *        "no more drift"
 * @param minWindowsAfter minimum number of windows that must remain from a candidate point to
 *        the end of the series (split roughly evenly into the two halves compared) before that
 *        point is even considered - too few windows on either side makes the half-averages
 *        themselves noisy, defeating the point
 * @param dt physics timestep in seconds, to convert `windowSeconds` into a tick width
 * @returns {{ convergedAtTick: number|null, windowMeans: Array<{tick: number, mean: number}> }}
 *          `convergedAtTick` is the earliest window's tick after which the series shows no
 *          further systematic drift, or null if no candidate point satisfies that within the
 *          series (including when there aren't enough windows to test any candidate at all).
 */
export function detectPlateau(samples, { windowSeconds = 300, toleranceRatio = 0.05, minWindowsAfter = 6, dt }) {
    if (!dt || dt <= 0) throw new Error('detectPlateau requires dt > 0');

    const sorted = [...samples].sort((a, b) => a.tick - b.tick);
    const windowTicks = windowSeconds / dt;

    const windowMeans = [];
    let windowStartTick = sorted.length ? sorted[0].tick : 0;
    let sum = 0;
    let count = 0;
    let i = 0;
    while (i < sorted.length) {
        const { tick, value } = sorted[i];
        if (tick - windowStartTick >= windowTicks && count > 0) {
            windowMeans.push({ tick: windowStartTick, mean: sum / count });
            windowStartTick = tick;
            sum = 0;
            count = 0;
        }
        sum += value;
        count += 1;
        i += 1;
    }
    if (count > 0) windowMeans.push({ tick: windowStartTick, mean: sum / count });

    const average = (values) => values.reduce((a, b) => a + b, 0) / values.length;

    for (let w = 0; w <= windowMeans.length - minWindowsAfter; w += 1) {
        const tail = windowMeans.slice(w);
        const mid = Math.ceil(tail.length / 2);
        const earlyMean = average(tail.slice(0, mid).map((x) => x.mean));
        const lateMean = average(tail.slice(mid).map((x) => x.mean));
        const relativeChange = earlyMean === 0 ? (lateMean === 0 ? 0 : Infinity) : Math.abs(lateMean - earlyMean) / Math.abs(earlyMean);

        if (relativeChange <= toleranceRatio) {
            return { convergedAtTick: windowMeans[w].tick, windowMeans };
        }
    }

    return { convergedAtTick: null, windowMeans };
}
