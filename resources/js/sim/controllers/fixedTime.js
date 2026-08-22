/**
 * controllers/fixedTime.js - build step 3.
 *
 * One two-phase, fixed-time controller per intersection:
 *   phase 0 - arterial through movement green
 *   phase 1 - cross-street movement green (both directions together; they
 *             do not conflict with each other, only with the arterial)
 *
 * Timing is computed once from the node's demand via Webster's method
 * (equations.js) whenever `recompute()` runs (on load and on demand-slider
 * change) - it never adapts mid-cycle. That is the adaptive controller's job
 * (controllers/adaptive.js, build step 5).
 */
import { websterOptimumCycle, websterGreenSplit } from '../equations.js';

/** Startup + clearance lost time per phase (standard textbook default), realised below as YELLOW_S + ALL_RED_S. */
const LOST_TIME_PER_PHASE_S = 4;
const YELLOW_S = 3;
const ALL_RED_S = 1;
/** Floor so a near-zero-demand phase (e.g. an unmodelled cross stub) still gets a legal minimum green. */
const MIN_GREEN_S = 6;
/** Used when Webster's method is undefined (Y >= 1, oversaturated) - keep cycling rather than throw mid-run. */
const FALLBACK_CYCLE_S = 120;

export class FixedTimeController {
    constructor(arterialDemand, crossDemand) {
        this.phase = 0; // 0 = arterial, 1 = cross
        this.phaseState = 'green'; // 'green' | 'yellow' | 'allRed'
        this.phaseElapsed = 0;
        this.recompute(arterialDemand, crossDemand);
    }

    /** demand: { spawnRatePerLanePerMin, saturationFlowPerLanePerHour } | null */
    recompute(arterialDemand, crossDemand) {
        const L = LOST_TIME_PER_PHASE_S * 2;
        const flowRatios = [flowRatio(arterialDemand), flowRatio(crossDemand)];

        let greens;
        try {
            const cycle = websterOptimumCycle(L, flowRatios);
            greens = websterGreenSplit(cycle, L, flowRatios);
        } catch {
            greens = [FALLBACK_CYCLE_S / 2 - L / 2, FALLBACK_CYCLE_S / 2 - L / 2];
        }

        this.greenDurations = greens.map((g) => Math.max(MIN_GREEN_S, g));
        this.cycleLengthS = this.greenDurations[0] + this.greenDurations[1] + L;
    }

    isArterialGreen() {
        return this.phase === 0 && this.phaseState === 'green';
    }

    isCrossGreen() {
        return this.phase === 1 && this.phaseState === 'green';
    }

    tick(dt) {
        this.phaseElapsed += dt;
        const greenDuration = this.greenDurations[this.phase];

        if (this.phaseState === 'green' && this.phaseElapsed >= greenDuration) {
            this.phaseState = 'yellow';
            this.phaseElapsed = 0;
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

export function flowRatio(demand) {
    if (!demand) return 0;
    const qPerHour = demand.spawnRatePerLanePerMin * 60;
    return qPerHour / demand.saturationFlowPerLanePerHour;
}
