/**
 * plateau.js - detects when a time series has settled into a steady state,
 * so warm-up length can be a measured answer instead of an asserted constant
 * (see sim/warmupProbe.js, which runs this before every batch, and
 * batch/warmupDiagnostics.mjs for checking it by eye).
 *
 * Deliberately generic over the underlying metric - it only sees
 * `{tick, value}` pairs, not what kind of value they are - so it works the
 * same way for wait time, throughput, or anything else sampled per tick.
 *
 * Two steps, on non-overlapping window means (batch means):
 *
 * 1. Truncation point - MSER (White 1997, "An effective truncation heuristic
 *    for bias reduction in simulation output"): cut the first d windows where
 *    d minimises the standard error of the mean of what's left,
 *    sum((Y_i - mean)^2) / (n - d)^2, searched over the first half of the run
 *    only. A still-rising ramp inflates that spread, so the minimum lands where
 *    the ramp ends. This replaced an early-half vs late-half comparison, which
 *    passed wherever the two halves happened to average out the same - e.g.
 *    across the middle of a steady climb - and gave 0 s, 300 s and 3000 s for
 *    curves that visibly settled at 600-2400 s on the 54-junction network.
 *
 * 2. Stationarity - MSER always picks some d, even for a series that never
 *    settles (a queue growing without bound). So what's left after the cut is
 *    checked for a trend: a least-squares line through its window means must
 *    not drift more than `driftTolerance` of its mean over `horizonSeconds`
 *    (the length of one measured run - a slow creep that barely moves within
 *    it doesn't bias it), or that drift must be indistinguishable from noise
 *    (|t| < 2). A cut at the very end of the search range also means no
 *    settled stretch was found - unless the best interior cut keeps the same
 *    mean within noise (interiorCutIfUnbiased()), in which case it stands.
 *    The trend test itself is metrics/definitions.js's trendSettled(), shared
 *    with the live panel's drift indicator.
 */
import { trend, trendSettled } from './metrics/definitions.js';

/**
 * MSER's minimum on the edge of its search range is ambiguous: either the ramp really lasts the
 * whole first half, or the second half just happens to be calmer than the middle (one noisy
 * window - an adaptive network's 55-60 min bump on hatfield-realistic, 2026-10-02 - is enough to
 * pull the cut to the edge while the level was already flat from 10 min). MSER's score is the
 * squared standard error of the kept mean, so the two are told apart by that: if the best interior
 * cut keeps a mean within 2 SE of the edge cut's, cutting further removes no bias and the interior
 * cut stands; if the earlier windows sit measurably off the later level, it is a ramp and the edge
 * cut (non-stationary) stays.
 */
function interiorCutIfUnbiased(scores, keptMeans, maxCut) {
    let interior = 0;
    for (let d = 1; d < maxCut; d += 1) if (scores[d] < scores[interior]) interior = d;
    const edgeSe = Math.sqrt(scores[maxCut]);
    return Math.abs(keptMeans[interior] - keptMeans[maxCut]) <= 2 * edgeSe ? interior : maxCut;
}

/**
 * @param samples time-ordered `[{tick, value}]` - gaps in `tick` are fine, only order matters
 * @param windowSeconds width of the non-overlapping window each mean is computed over, in sim
 *        seconds. Matched to RECOVERY_SMOOTHING_WINDOW_SECONDS's reasoning in runHeadless.js by
 *        default (300s, one full demand-fluctuation cycle) so the same cyclic ripple that
 *        motivated that window doesn't get mistaken for "still converging" here.
 * @param driftTolerance how far a line through the kept windows may drift over `horizonSeconds`, as a
 *        fraction of their mean, and still count as settled
 * @param horizonSeconds the span that drift is measured over - the measured window of the runs
 *        this warm-up is for; defaults to everything kept after the cut
 * @param minWindows fewest windows worth testing at all - fewer and even the kept half is too
 *        short to tell a trend from noise
 * @param dt physics timestep in seconds, to convert `windowSeconds` into a tick width
 * @returns {{ convergedAtTick: number|null, truncationTick: number|null, stationary: boolean,
 *            driftRatio: number|null, windowMeans: Array<{tick: number, mean: number}> }}
 *          `truncationTick` is MSER's cut; `convergedAtTick` is the same tick when what follows
 *          it is stationary, null otherwise (or when there are too few windows to tell).
 */
export function detectPlateau(samples, { windowSeconds = 300, driftTolerance = 0.15, horizonSeconds = null, minWindows = 8, dt }) {
    if (!dt || dt <= 0) throw new Error('detectPlateau requires dt > 0');

    const sorted = [...samples].sort((a, b) => a.tick - b.tick);
    const windowTicks = windowSeconds / dt;

    const windowMeans = [];
    let windowStartTick = sorted.length ? sorted[0].tick : 0;
    let sum = 0;
    let count = 0;
    for (const { tick, value } of sorted) {
        if (tick - windowStartTick >= windowTicks && count > 0) {
            windowMeans.push({ tick: windowStartTick, mean: sum / count });
            windowStartTick = tick;
            sum = 0;
            count = 0;
        }
        sum += value;
        count += 1;
    }
    // A trailing partial window is noisier than the rest - only keep it if it's at least half full.
    if (count > 0 && (sorted[sorted.length - 1].tick - windowStartTick + 1) * 2 >= windowTicks) windowMeans.push({ tick: windowStartTick, mean: sum / count });

    const none = { convergedAtTick: null, truncationTick: null, stationary: false, driftRatio: null, windowMeans };
    const n = windowMeans.length;
    if (n < minWindows) return none;

    const values = windowMeans.map((w) => w.mean);
    const maxCut = Math.floor(n / 2);
    const scores = [];
    const keptMeans = [];
    for (let d = 0; d <= maxCut; d += 1) {
        const kept = values.slice(d);
        const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
        keptMeans.push(mean);
        scores.push(kept.reduce((s, y) => s + (y - mean) ** 2, 0) / kept.length ** 2);
    }
    let bestCut = scores.indexOf(Math.min(...scores));
    if (bestCut === maxCut) bestCut = interiorCutIfUnbiased(scores, keptMeans, maxCut);

    const horizonWindows = horizonSeconds == null ? n - bestCut : horizonSeconds / windowSeconds;
    const { driftRatio, settled } = trendSettled(trend(values.slice(bestCut)), horizonWindows, driftTolerance);
    const stationary = bestCut < maxCut && settled;
    const truncationTick = windowMeans[bestCut].tick;
    return { convergedAtTick: stationary ? truncationTick : null, truncationTick, stationary, driftRatio, windowMeans };
}
