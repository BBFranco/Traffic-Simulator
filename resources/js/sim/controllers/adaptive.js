/**
 * controllers/adaptive.js - build step 5.
 *
 * Same two-phase structure as the fixed-time controller, but phase length is
 * not pre-computed: each green holds for at least the minimum, then extends
 * for as long as `equations.js:shouldExtendGreen()` says the sensed queue
 * still justifies it, capped at a maximum. It also won't switch to a phase
 * whose sensed demand doesn't clear `equations.js:hasSufficientCall()` - it
 * keeps resting on green instead, same as a real actuated controller with no
 * (or no significant) call on the other phase.
 */
import { ADAPTIVE_DEFAULTS, hasSufficientCall, shouldExtendGreen } from '../equations.js';

const YELLOW_S = 3;
const ALL_RED_S = 1;

export class AdaptiveController {
    constructor(params = ADAPTIVE_DEFAULTS) {
        this.params = params;
        this.phase = 0; // 0 = arterial, 1 = cross
        this.phaseState = 'green';
        this.phaseElapsed = 0;
    }

    isArterialGreen() {
        return this.phase === 0 && this.phaseState === 'green';
    }

    isCrossGreen() {
        return this.phase === 1 && this.phaseState === 'green';
    }

    /**
     * sensedQueueForCurrentPhase: reading from sensors.js for whichever approach currently has green.
     * sensedQueueForOtherPhase: same, for the approach that would receive the next green.
     *
     * `maxGreen` only exists to bound how long an actual waiting call can be kept waiting - with
     * literally no one there, there is nothing for it to protect against, so a truly empty other
     * phase always keeps resting on green; a small (sub-`minCallToSwitch`) call is bounded by
     * maxGreen so it isn't left waiting forever; a call at/above `minCallToSwitch` competes on the
     * current phase's own gap-out via shouldExtendGreen(), same as before.
     */
    tick(dt, sensedQueueForCurrentPhase, sensedQueueForOtherPhase = Infinity) {
        this.phaseElapsed += dt;

        if (this.phaseState === 'green') {
            const otherHasNoCall = sensedQueueForOtherPhase === 0;
            const otherCallInsufficient = !otherHasNoCall && !hasSufficientCall(sensedQueueForOtherPhase, this.params);
            const extend =
                shouldExtendGreen(sensedQueueForCurrentPhase, this.phaseElapsed, this.params) ||
                otherHasNoCall ||
                (otherCallInsufficient && this.phaseElapsed < this.params.maxGreen);
            if (!extend) {
                this.phaseState = 'yellow';
                this.phaseElapsed = 0;
            }
        } else if (this.phaseState === 'yellow' && this.phaseElapsed >= YELLOW_S) {
            this.phaseState = 'allRed';
            this.phaseElapsed = 0;
        } else if (this.phaseState === 'allRed' && this.phaseElapsed >= ALL_RED_S) {
            this.phase = 1 - this.phase;
            this.phaseState = 'green';
            this.phaseElapsed = 0;
        }
    }
}
