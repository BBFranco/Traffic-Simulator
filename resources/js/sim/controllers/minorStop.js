/**
 * controllers/minorStop.js - a stop-street junction (corridor `control: "stop"`).
 *
 * The arterial runs straight through - always green, no stop line - and the minor road
 * (phase 1) stops at its line and gives way. There is no timer: the engine releases a
 * waiting minor-road car once it has stopped for its hesitation and no arterial vehicle
 * is in the junction or about to reach it (engine.js#_updateMinorStopReleases), reusing the
 * all-way stop's per-approach clock.
 */
export class MinorStopController {
    constructor() {
        this.phase = 0;
        this.inTurn = false;
        this.phaseState = 'green';
        this.phaseElapsed = 0;
    }

    isArterialGreen() {
        return true;
    }

    isCrossGreen() {
        return false;
    }

    tick() {}
}
