/**
 * controllers/fixedTime.js - build step 3.
 *
 * One fixed-time controller per intersection, cycling through its stages:
 *   phase 0 - arterial through movement green
 *   phase 1 - cross-street movement green (both directions together; they
 *             do not conflict with each other, only with the arterial)
 * A road with a protected turn gets a lead turn stage in front of its through green
 * (phasePlan.js) - `inTurn` says which of the two the current stage is.
 *
 * Timing is computed once from the node's demand via Webster's method
 * (equations.js) whenever `recompute()` runs (on load and on demand-slider
 * change) - it never adapts mid-cycle. That is the adaptive controller's job
 * (controllers/adaptive.js, build step 5).
 */
import { ALL_RED_S, YELLOW_S, buildStages, fallbackGreens, flowRatio, lostTimeS, minGreenOf, stageRatios, websterCycleFor, websterGreens } from './phasePlan.js';

export { flowRatio };

export class FixedTimeController {
    /** turn: per road (0 arterial, 1 cross) null, or `{ demand, weight }` for the protected turn stage in front of its through green. */
    constructor(arterialDemand, crossDemand, turn = [null, null]) {
        this.stepIndex = 0;
        this.phaseState = 'green'; // 'green' | 'yellow' | 'allRed'
        this.phaseElapsed = 0;
        this.recompute(arterialDemand, crossDemand, turn);
    }

    /** The road whose stage this is - 0 arterial, 1 cross. */
    get phase() {
        return this.stages[this.stepIndex].phase;
    }

    /** Is the current stage a lead turn stage rather than a through green. */
    get inTurn() {
        return this.stages[this.stepIndex].turn;
    }

    /** demand: { spawnRatePerLanePerMin, saturationFlowPerLanePerHour } | null */
    recompute(arterialDemand, crossDemand, turn = [null, null]) {
        this.stages = buildStages(turn);
        this.stepIndex = Math.min(this.stepIndex, this.stages.length - 1);

        let greens;
        try {
            const ratios = stageRatios(this.stages, arterialDemand, crossDemand, turn);
            greens = websterGreens(this.stages, ratios, websterCycleFor(this.stages, ratios));
        } catch {
            greens = fallbackGreens(this.stages, turn);
        }

        this.stageGreens = greens.map((g, i) => Math.max(minGreenOf(this.stages[i]), g));
        /** The through green of each road, and the turn green in front of it (null where it has none). */
        this.greenDurations = [0, 1].map((p) => this.stageGreens[this.stages.findIndex((s) => s.phase === p && !s.turn)]);
        this.turnDurations = [0, 1].map((p) => {
            const i = this.stages.findIndex((s) => s.phase === p && s.turn);
            return i < 0 ? null : this.stageGreens[i];
        });
        this.cycleLengthS = this.stageGreens.reduce((sum, g) => sum + g, 0) + lostTimeS(this.stages);
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

    tick(dt) {
        this.phaseElapsed += dt;
        const greenDuration = this.stageGreens[this.stepIndex];

        if (this.phaseState === 'green' && this.phaseElapsed >= greenDuration) {
            this.phaseState = 'yellow';
            this.phaseElapsed = 0;
        } else if (this.phaseState === 'yellow' && this.phaseElapsed >= YELLOW_S) {
            this.phaseState = 'allRed';
            this.phaseElapsed = 0;
        } else if (this.phaseState === 'allRed' && this.phaseElapsed >= ALL_RED_S) {
            this.stepIndex = (this.stepIndex + 1) % this.stages.length;
            this.phaseState = 'green';
            this.phaseElapsed = 0;
        }
    }
}
