/**
 * demandEstimator.js - the common per-approach demand estimate every sensor feeds (sensor overhaul, 2026-10-15).
 *
 * Is the phase that would receive the next green worth taking green away for? Decided from the
 * waiting phase's detector frames (sensors.js's observeDetector()) and what those frames can
 * carry (the spec's `outputs`) - never from which sensor produced them:
 *
 *  - presence only (no count): counting depth is not a capability, so a call just has to persist
 *    `callDebounceS` uninterrupted seconds.
 *  - a count: compared to `minCallToSwitch`, smoothed first when the spec declares a count filter
 *    (and then only once the call has been present for the whole window); a call held
 *    `maxCallWaitS` is served whatever its depth, so a short queue isn't stranded until maxGreen.
 *  - queue extent: a standing queue reported back over an advance zone is a real call at once.
 *
 * `state` is the junction's estimator memory: callPersistenceS[phase] and countSamples[phase].
 */
import { hasSufficientCall } from './equations.js';

/**
 * @param state        { callPersistenceS: [number, number], countSamples: [Array, Array] }
 * @param currentPhase the phase holding green now
 * @param frames       the waiting phase's detector frames (after latency and errors)
 * @param readCount    frame -> reported count (draws the frame's count noise)
 * @param outputs      the sensor spec's `outputs`
 * @param params       ADAPTIVE_DEFAULTS-shaped controller params
 */
export function isOtherCallSufficient({ state, currentPhase, frames, readCount, outputs, params, dt, simTimeS }) {
    const otherPhase = 1 - currentPhase;
    state.callPersistenceS[currentPhase] = 0; // never "waiting" on itself while it holds green

    if (!outputs.count) {
        const present = frames.some((f) => f.presence);
        state.callPersistenceS[otherPhase] = present ? state.callPersistenceS[otherPhase] + dt : 0;
        if (frames.some((f) => f.queueExtent)) return true;
        return state.callPersistenceS[otherPhase] >= params.callDebounceS;
    }

    const queue = frames.reduce((sum, f) => sum + readCount(f), 0);
    const present = frames.some((f) => f.presence);
    state.callPersistenceS[otherPhase] = present ? state.callPersistenceS[otherPhase] + dt : 0;
    if (frames.some((f) => f.queueExtent)) return true;
    if (state.callPersistenceS[otherPhase] >= params.maxCallWaitS) return true;

    const filter = outputs.count.filter;
    if (!filter) return hasSufficientCall(queue, params);
    if (filter.type !== 'moving_average') throw new Error(`Unknown count filter "${filter.type}"`);

    const samples = state.countSamples[otherPhase];
    state.countSamples[currentPhase] = [];
    samples.push({ tS: simTimeS, queue });
    while (samples.length && samples[0].tS <= simTimeS - filter.windowS) samples.shift();
    const windowCovered = state.callPersistenceS[otherPhase] >= filter.windowS;
    const meanQueue = samples.reduce((sum, s) => sum + s.queue, 0) / samples.length;
    return windowCovered && hasSufficientCall(Math.round(meanQueue), params);
}
