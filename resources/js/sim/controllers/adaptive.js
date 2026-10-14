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
import { ALL_RED_S, MIN_TURN_GREEN_S, YELLOW_S } from './phasePlan.js';

/** A protected turn stage's longest green before its weight - it also ends as soon as its lane stops actuating the detector. */
export const MAX_TURN_GREEN_S = 25;

export class AdaptiveController {
    /** turnWeights: per road (0 arterial, 1 cross) null, or the weight of the protected turn stage in front of its through green. */
    constructor(params = ADAPTIVE_DEFAULTS, turnWeights = [null, null]) {
        this.params = params;
        this.turnWeights = turnWeights;
        this.phase = 0; // 0 = arterial, 1 = cross
        this.inTurn = false; // the current stage is road `phase`'s lead turn stage rather than its through green
        this.phaseState = 'green';
        this.phaseElapsed = 0;
        this.secondsSinceLastDetection = 0; // gap timer for the current green's stop-line detector
    }

    isArterialGreen() {
        return this.phase === 0 && !this.inTurn && this.phaseState === 'green';
    }

    isCrossGreen() {
        return this.phase === 1 && !this.inTurn && this.phaseState === 'green';
    }

    /** Is road `phase`'s protected turn showing its green arrow. */
    turnGreen(phase) {
        return this.inTurn && this.phase === phase && this.phaseState === 'green';
    }

    turnYellow(phase) {
        return this.inTurn && this.phase === phase && this.phaseState === 'yellow';
    }

    /**
     * vehicleDetectedThisTick: did a vehicle actuate the stop-line detector on the currently
     * green approach this tick (sensors.js's `detectPresenceAtStopLine()`) - resets the gap timer.
     * otherCallSufficient: is the approach that would receive the next green already worth taking
     * green away for, as engine.js has decided it (sensor-mode aware) - false means keep resting.
     *
     * Resting on green and gap-extension both still bow out at `maxGreen` - it's a hard cap on
     * every branch, not just the gap-extension one.
     *
     * turnCalls: per road, is a vehicle waiting in its protected turn lane(s) - a road with a turn
     * stage and a call opens it with the turn stage (otherwise it skips straight to the through green).
     * While a turn stage is green `vehicleDetectedThisTick` is the turn lanes' own detector, and the
     * stage holds for at least the minimum, gaps out like any green, and caps at its weighted maximum.
     */
    tick(dt, vehicleDetectedThisTick, otherCallSufficient = false, turnCalls = [false, false]) {
        this.phaseElapsed += dt;

        if (this.phaseState === 'green' && this.inTurn) {
            this.secondsSinceLastDetection = vehicleDetectedThisTick ? 0 : this.secondsSinceLastDetection + dt;
            const extend =
                this.phaseElapsed < MAX_TURN_GREEN_S * this.turnWeights[this.phase] &&
                (this.phaseElapsed < MIN_TURN_GREEN_S * this.turnWeights[this.phase] || this.secondsSinceLastDetection < this.params.gapOutS);
            if (!extend) {
                this.phaseState = 'yellow';
                this.phaseElapsed = 0;
            }
        } else if (this.phaseState === 'green') {
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
            if (this.inTurn) {
                this.inTurn = false; // the turn stage hands over to its own road's through green
            } else {
                this.phase = 1 - this.phase;
                this.inTurn = this.turnWeights[this.phase] != null && turnCalls[this.phase];
            }
            this.phaseState = 'green';
            this.phaseElapsed = 0;
            this.secondsSinceLastDetection = 0;
        }
    }
}
