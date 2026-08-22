/**
 * controllers/greenWave.js - build step 10.
 *
 * One shared cycle length/green split for the whole arterial (Webster's
 * method - equations.js - using the arterial's own demand paired against the
 * average cross flow ratio across its connector-bearing nodes), with each
 * node's phase timing shifted by a fixed offset -
 * equations.js:greenWaveOffset() - so a car travelling at the arterial's
 * target speed sees every light turn green just as it arrives (Roess,
 * Prassas & McShane, 2004).
 *
 * Unlike FixedTimeController, this is stateless: `tick()` derives the phase
 * directly from absolute sim time modulo the cycle, so every node on the
 * arterial stays perfectly in step with no drift, and rebuilding it on a
 * demand change never loses "where in the cycle" it was - there is nothing
 * to lose.
 */
import { websterOptimumCycle, websterGreenSplit, greenWaveOffset } from '../equations.js';
import { flowRatio } from './fixedTime.js';

const LOST_TIME_PER_PHASE_S = 4;
const YELLOW_S = 3;
const ALL_RED_S = 1;
const MIN_GREEN_S = 6;
const FALLBACK_CYCLE_S = 120;

export class GreenWaveController {
    constructor({ offsetS, cycleLengthS, greenDurations }) {
        this.offsetS = offsetS;
        this.cycleLengthS = cycleLengthS;
        this.greenDurations = greenDurations;
        this.phase = 0;
        this.phaseState = 'green';
    }

    isArterialGreen() {
        return this.phase === 0 && this.phaseState === 'green';
    }

    isCrossGreen() {
        return this.phase === 1 && this.phaseState === 'green';
    }

    tick(dt, simTimeS) {
        const t = mod(simTimeS - this.offsetS, this.cycleLengthS);
        const segments = [
            [0, 'green', this.greenDurations[0]],
            [0, 'yellow', YELLOW_S],
            [0, 'allRed', ALL_RED_S],
            [1, 'green', this.greenDurations[1]],
            [1, 'yellow', YELLOW_S],
            [1, 'allRed', ALL_RED_S],
        ];
        let acc = 0;
        for (const [phase, state, len] of segments) {
            if (t < acc + len) {
                this.phase = phase;
                this.phaseState = state;
                return;
            }
            acc += len;
        }
        // Floating-point edge at exactly the cycle boundary.
        this.phase = 0;
        this.phaseState = 'green';
    }
}

/**
 * @param nodeInfos      this arterial's node infos, in arterial order (engine.js's `nodeInfosByArterial` entry)
 * @param arterialDemand { spawnRatePerLanePerMin, saturationFlowPerLanePerHour }
 * @param crossDemandFor (node) => demand | null, same shape FixedTimeController expects
 * @param targetSpeedMps progression speed the offset chain is built for
 * @returns Map<nodeId, GreenWaveController>
 */
export function buildGreenWaveControllers(nodeInfos, arterialDemand, crossDemandFor, targetSpeedMps) {
    const arterialY = flowRatio(arterialDemand);
    const crossDemands = nodeInfos.map((info) => crossDemandFor(info.node)).filter(Boolean);
    const avgCrossY = crossDemands.length
        ? crossDemands.reduce((sum, d) => sum + flowRatio(d), 0) / crossDemands.length
        : 0;
    const L = LOST_TIME_PER_PHASE_S * 2;

    let greenDurations;
    try {
        const cycle = websterOptimumCycle(L, [arterialY, avgCrossY]);
        greenDurations = websterGreenSplit(cycle, L, [arterialY, avgCrossY]);
    } catch {
        greenDurations = [FALLBACK_CYCLE_S / 2 - L / 2, FALLBACK_CYCLE_S / 2 - L / 2];
    }
    greenDurations = greenDurations.map((g) => Math.max(MIN_GREEN_S, g));
    const cycleLengthS = greenDurations[0] + greenDurations[1] + L;

    const controllers = new Map();
    let offsetS = 0;
    nodeInfos.forEach((info, i) => {
        if (i > 0) {
            const prevDistanceM = nodeInfos[i - 1].node.distanceToNextM ?? 0;
            offsetS += greenWaveOffset(prevDistanceM, targetSpeedMps);
        }
        controllers.set(info.node.id, new GreenWaveController({ offsetS, cycleLengthS, greenDurations }));
    });
    return controllers;
}

function mod(a, n) {
    return ((a % n) + n) % n;
}
