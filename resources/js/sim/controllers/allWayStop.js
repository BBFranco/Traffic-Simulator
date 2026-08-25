/**
 * controllers/allWayStop.js - build step 6, refined for load-shedding chaos.
 *
 * Load-shedding fallback: signal heads go dark and every approach becomes a
 * stop-controlled approach. There is still no full multi-way right-of-way
 * arbitration (no arrival-order queue across legs) - but two things keep it
 * from reading as four independent red lights that happen to share a corner:
 *
 * 1. Randomised dwell (`MIN_STOP_DWELL_S` + up to `STOP_DWELL_JITTER_S`),
 *    rolled once PER APPROACH (arterial, or cross street) at each node when
 *    it goes from empty to having someone queued - not per car - so not
 *    every 4-way stop clears at exactly the same pace, some take longer to
 *    get moving than others, same idea as car.js's startupDelayS jitter but
 *    at the group level. See engine.js#_updateAllWayStopLegClock: a per-car
 *    version was tried and visibly wrong - four lanes that all stopped in
 *    the same instant would peel off in two separate waves, whichever pair's
 *    own random timer happened to finish first, instead of going together
 *    the moment the FIRST car in the group had waited long enough.
 * 2. A junction occupancy lock (`junctionClearTimeS()`): once ANY approach
 *    releases its cars, the engine (engine.js#_updateAllWayStopReleases)
 *    records "this node is occupied until T" and withholds release from
 *    every other approach until T passes, even if its own dwell is already
 *    up. This is what stops two cars from opposite/crossing approaches
 *    being released into the box on the same tick and driving into each
 *    other.
 * 3. True first-come-first-served between the two conflicting sides
 *    (arterial vs. cross), by comparing whose arrival clock started first -
 *    not a fixed alternating turn order, which let a heavy-traffic side win
 *    the race for a freed lock again and again and starve a lighter side
 *    far past its own wait time. See engine.js#_updateAllWayStopReleases
 *    for the actual comparison.
 */
export const MIN_STOP_DWELL_S = 2;
/** Upper bound of the extra randomised wait on top of MIN_STOP_DWELL_S - real drivers don't all count to exactly the same number before going. */
export const STOP_DWELL_JITTER_S = 2.5;

/** Assumed speed (m/s) a car pulling away from a dead stop clears the junction box at - used only to size the occupancy lock, not real physics. */
const JUNCTION_CLEAR_SPEED_MPS = 6;
/** Added to the box span to account for the releasing car's own length needing to fully exit before it's safe for the next approach. */
const JUNCTION_CLEAR_LENGTH_BUFFER_M = 5;

/** How long a just-released car needs to fully clear `node`'s box, sized off its actual (cross/arterial) road widths so a wide intersection locks longer than a narrow one. */
export function junctionClearTimeS(node) {
    const boxSpanM = Math.max(node.crossRoadWidthM ?? 0, node.arterialRoadWidthM ?? 0);
    return (boxSpanM + JUNCTION_CLEAR_LENGTH_BUFFER_M) / JUNCTION_CLEAR_SPEED_MPS;
}

/** Wider, separately-rolled reaction lag for pulling away from a stop-sign dead stop - a driver checking a 4-way box for cross traffic pauses longer than one just re-accelerating off a green (car.js's generic startupDelayS/MAX_STARTUP_DELAY_S). */
export const RELEASE_HESITATION_MIN_S = 0.4;
export const RELEASE_HESITATION_JITTER_S = 1.6;

export class AllWayStopController {
    // Never green in the signal-phase sense - the engine queries
    // `requiresStopAndGo()` instead of isArterialGreen/isCrossGreen for this
    // controller type.
    isArterialGreen() {
        return false;
    }

    isCrossGreen() {
        return false;
    }

    tick() {
        // No phase timer - release is decided by the engine per approach, from
        // that approach's own shared arrival/dwell clock (see MIN_STOP_DWELL_S).
    }
}
