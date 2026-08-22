/**
 * controllers/allWayStop.js - build step 6.
 *
 * Load-shedding fallback: signal heads go dark and every approach becomes a
 * stop-controlled approach. This does not attempt full multi-way right-of-way
 * arbitration - every approach's leading car must come to a complete stop at
 * the line; once stopped for `MIN_STOP_DWELL_S` it is released (the engine
 * drops the virtual stop-line obstacle for that one car), matching the real
 * "stop, check, go" behaviour without needing to model conflicting approaches
 * fighting over the same junction.
 */
export const MIN_STOP_DWELL_S = 2;

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
        // No phase timer - release is per-car, decided by the engine from each
        // car's own stopped-dwell time (see MIN_STOP_DWELL_S).
    }
}
