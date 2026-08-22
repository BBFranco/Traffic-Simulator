/**
 * controllers/adaptive.js - build step 5.
 *
 * Same two-phase structure as the fixed-time controller, but phase length is
 * not pre-computed: each green holds for at least the minimum, then extends
 * on a gap timer - `equations.js:shouldExtendGreen()` keeps it open as long
 * as a vehicle has actuated the stop-line detector within the last `gapOutS`
 * seconds, capped at a maximum. It also won't switch to a phase whose call
 * isn't sufficient yet - engine.js decides what "sufficient" means (a big
 * enough sensed queue, or a call that's simply persisted long enough, for
 * sensors too narrow to count depth - see its `_isOtherCallSufficient()`) and
 * hands this controller a plain boolean, so it stays sensor-agnostic.
 */
import { ADAPTIVE_DEFAULTS, shouldExtendGreen } from '../equations.js';

const YELLOW_S = 3;
const ALL_RED_S = 1;

export class AdaptiveController {
    constructor(params = ADAPTIVE_DEFAULTS) {
        this.params = params;
        this.phase = 0; // 0 = arterial, 1 = cross
        this.phaseState = 'green';
        this.phaseElapsed = 0;
        this.secondsSinceLastDetection = 0; // gap timer for the current green's stop-line detector
    }

    isArterialGreen() {
        return this.phase === 0 && this.phaseState === 'green';
    }

    isCrossGreen() {
        return this.phase === 1 && this.phaseState === 'green';
    }

    /**
     * vehicleDetectedThisTick: did a vehicle actuate the stop-line detector on the currently
     * green approach this tick (sensors.js's `detectPresenceAtStopLine()`) - resets the gap timer.
     * otherCallSufficient: is the approach that would receive the next green already worth taking
     * green away for, as engine.js has decided it (sensor-mode aware) - false means keep resting.
     *
     * Resting on green and gap-extension both still bow out at `maxGreen` - it's a hard cap on
     * every branch, not just the gap-extension one.
     */
    tick(dt, vehicleDetectedThisTick, otherCallSufficient = false) {
        this.phaseElapsed += dt;

        if (this.phaseState === 'green') {
            this.secondsSinceLastDetection = vehicleDetectedThisTick ? 0 : this.secondsSinceLastDetection + dt;

            const extend =
                this.phaseElapsed < this.params.maxGreen &&
                (shouldExtendGreen(this.secondsSinceLastDetection, this.phaseElapsed, this.params) || !otherCallSufficient);
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
            this.secondsSinceLastDetection = 0;
        }
    }
}
