/**
 * controllers/greenWave.js - build step 10.
 *
 * One shared cycle length for the whole arterial, set by its critical
 * intersection - the node whose own Webster cycle (equations.js) is longest -
 * as standard coordinated-signal practice does (Roess, Prassas & McShane,
 * 2004). Each node then splits that common cycle by its OWN arterial/cross
 * flow ratios. (An earlier version fed Webster the arterial-wide AVERAGE
 * flow ratios instead, which under-greened the busiest node - usually the
 * entry - and turned it into a bottleneck that broke the platoon before the
 * offsets could carry it.) Each
 * node's phase timing is shifted by a fixed offset -
 * equations.js:greenWaveOffset() plus a start-from-rest lag (see
 * startFromRestLagS()) - so a platoon released at one light sees the next
 * turn green just as it arrives (Roess, Prassas & McShane, 2004).
 *
 * Unlike FixedTimeController, this is stateless: `tick()` derives the phase
 * directly from absolute sim time modulo the cycle, so every node on the
 * arterial stays perfectly in step with no drift, and rebuilding it on a
 * demand change never loses "where in the cycle" it was - there is nothing
 * to lose.
 */
import { websterOptimumCycle, websterGreenSplit, greenWaveOffset, IDM_DEFAULTS } from '../equations.js';
import { flowRatio } from './fixedTime.js';

const LOST_TIME_PER_PHASE_S = 4;
const YELLOW_S = 3;
const ALL_RED_S = 1;
const MIN_GREEN_S = 6;
const FALLBACK_CYCLE_S = 120;

/**
 * Extra link travel time for a platoon that leaves the upstream stop line from rest rather
 * than at cruise: accelerating at a constant `a` up to v0 loses v0 / (2a) seconds against
 * cruising the whole link. greenWaveOffset()'s d / v0 alone assumes a moving platoon, but on
 * these short links every node's green opens on a standing queue - measured on the Hatfield
 * corridor, the pure d / v0 chain was worse than no offsets at all (arterial wait 37.8 s vs
 * 25.3 s), while adding this lag brought it to 18.0 s against fixed-time's ~30.5 s.
 */
function startFromRestLagS(targetSpeedMps) {
    return targetSpeedMps / (2 * IDM_DEFAULTS.a);
}

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
 * @param arterialDemandFor (node) => { spawnRatePerLanePerMin, saturationFlowPerLanePerHour } arriving on the arterial there
 * @param crossDemandFor (node) => demand | null, same shape FixedTimeController expects
 * @param targetSpeedMps progression speed the offset chain is built for
 * @returns Map<nodeId, GreenWaveController>
 */
export function buildGreenWaveControllers(nodeInfos, arterialDemandFor, crossDemandFor, targetSpeedMps) {
    const L = LOST_TIME_PER_PHASE_S * 2;
    const flowRatiosByNode = nodeInfos.map((info) => [flowRatio(arterialDemandFor(info.node)), flowRatio(crossDemandFor(info.node))]);

    // Oversaturated anywhere (Y >= 1) -> Webster is undefined for the critical node, so the
    // whole arterial falls back to the same fixed cycle FixedTimeController uses.
    let cycleLengthS;
    try {
        cycleLengthS = Math.max(...flowRatiosByNode.map((ys) => websterOptimumCycle(L, ys)));
    } catch {
        cycleLengthS = FALLBACK_CYCLE_S;
    }
    // Every node's minimum greens still have to fit inside the common cycle.
    cycleLengthS = Math.max(cycleLengthS, 2 * MIN_GREEN_S + L);

    const controllers = new Map();
    let offsetS = 0;
    nodeInfos.forEach((info, i) => {
        if (i > 0) {
            const prevDistanceM = nodeInfos[i - 1].node.distanceToNextM ?? 0;
            offsetS += greenWaveOffset(prevDistanceM, targetSpeedMps) + startFromRestLagS(targetSpeedMps);
        }
        const greenDurations = splitCommonCycle(cycleLengthS, L, flowRatiosByNode[i]);
        controllers.set(info.node.id, new GreenWaveController({ offsetS, cycleLengthS, greenDurations }));
    });
    return controllers;
}

/**
 * One node's Webster split of the arterial's common cycle. The minimum-green floor takes its
 * time from the other phase rather than lengthening the cycle, so every node keeps the exact
 * common cycle the offsets are built on.
 */
function splitCommonCycle(cycleLengthS, L, flowRatios) {
    const effectiveGreen = cycleLengthS - L;
    const Y = flowRatios[0] + flowRatios[1];
    const [arterialGreen] = Y > 0 ? websterGreenSplit(cycleLengthS, L, flowRatios) : [effectiveGreen / 2];
    const clampedArterial = Math.min(Math.max(arterialGreen, MIN_GREEN_S), effectiveGreen - MIN_GREEN_S);
    return [clampedArterial, effectiveGreen - clampedArterial];
}

function mod(a, n) {
    return ((a % n) + n) % n;
}
