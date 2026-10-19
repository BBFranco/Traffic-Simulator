/**
 * demandEstimator.js - the call rule every sensor feeds (sensor overhaul, 2026-10-15; shared rule 2026-10-16).
 *
 * Is the phase that would receive the next green worth taking green away for? One rule for all
 * four sensors: a call is sufficient once presence on the waiting road has persisted `callDebounceS`
 * uninterrupted seconds. Counts and queue extent are still observed (sensors.js's frames) but never
 * decide the switch - so sensors differ only in what they see (zones, latency), not in how the
 * controller acts on it.
 *
 * Why (2026-10-16 call-rule probe, 3 seeds x 4 sensors x adaptive/coordinated): the previous rule made
 * counting sensors wait for `minCallToSwitch` vehicles or `maxCallWaitS`, which alone cost radar and
 * camera 2.3-3.1 s of mean wait against the loop; switching early on a count (when 5+ queue) added
 * nothing for radar and was slightly worse for camera.
 *
 * `state` is the junction's estimator memory: callPersistenceS[phase] (and countSamples[phase], legacy only).
 */
import { hasSufficientCall } from './equations.js';

/**
 * @param state        { callPersistenceS: [number, number] }
 * @param currentPhase the phase holding green now
 * @param frames       the waiting phase's detector frames (after latency and errors)
 * @param params       ADAPTIVE_DEFAULTS-shaped controller params
 */
export function isOtherCallSufficient({ state, currentPhase, frames, params, dt }) {
    const otherPhase = 1 - currentPhase;
    state.callPersistenceS[currentPhase] = 0; // never "waiting" on itself while it holds green
    state.callPersistenceS[otherPhase] = frames.some((f) => f.presence) ? state.callPersistenceS[otherPhase] + dt : 0;
    return state.callPersistenceS[otherPhase] >= params.callDebounceS;
}

/**
 * The pre-2026-10-16 rule, kept only so the 'legacy' sensor spec set keeps reproducing the
 * pre-overhaul build (its permanent hash keys): presence-only sensors wait out `callDebounceS`, a
 * queue over an advance zone calls at once, and counting sensors need `minCallToSwitch` vehicles
 * (smoothed first under a count filter) or a call held `maxCallWaitS`.
 *
 * @param readCount frame -> reported count (draws the frame's count noise)
 * @param outputs   the sensor spec's `outputs`
 */
export function legacyCallSufficient({ state, currentPhase, frames, readCount, outputs, params, dt, simTimeS }) {
    const otherPhase = 1 - currentPhase;
    state.callPersistenceS[currentPhase] = 0;

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
