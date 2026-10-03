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
import { greenWaveOffset, IDM_DEFAULTS } from '../equations.js';
import { ALL_RED_S, FALLBACK_CYCLE_S, YELLOW_S, buildStages, floorWithinCycle, lostTimeS, minGreenOf, stageRatios, websterCycleFor, websterGreens } from './phasePlan.js';

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
    /** stages: phasePlan.js's buildStages(); stageGreens: each stage's green, in the same order. */
    constructor({ offsetS, cycleLengthS, stages, stageGreens }) {
        this.offsetS = offsetS;
        this.cycleLengthS = cycleLengthS;
        this.stages = stages;
        this.stageGreens = stageGreens;
        this.greenDurations = [0, 1].map((p) => stageGreens[stages.findIndex((s) => s.phase === p && !s.turn)]);
        this.turnDurations = [0, 1].map((p) => {
            const i = stages.findIndex((s) => s.phase === p && s.turn);
            return i < 0 ? null : stageGreens[i];
        });
        this.segments = stages.flatMap((stage, i) => [
            [stage, 'green', stageGreens[i]],
            [stage, 'yellow', YELLOW_S],
            [stage, 'allRed', ALL_RED_S],
        ]);
        this.phase = 0;
        this.inTurn = false;
        this.phaseState = 'green';
        this.phaseElapsed = 0;
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

    tick(dt, simTimeS) {
        const t = mod(simTimeS - this.offsetS, this.cycleLengthS);
        let acc = 0;
        for (const [stage, state, len] of this.segments) {
            if (t < acc + len) {
                this.phase = stage.phase;
                this.inTurn = stage.turn;
                this.phaseState = state;
                this.phaseElapsed = t - acc;
                return;
            }
            acc += len;
        }
        // Floating-point edge at exactly the cycle boundary.
        [this.phase, this.inTurn, this.phaseState, this.phaseElapsed] = [this.segments[0][0].phase, this.segments[0][0].turn, 'green', 0];
    }
}

/**
 * @param nodeInfos      this arterial's node infos, in arterial order (engine.js's `nodeInfosByArterial` entry)
 * @param arterialDemandFor (node) => { spawnRatePerLanePerMin, saturationFlowPerLanePerHour } arriving on the arterial there
 * @param crossDemandFor (node) => demand | null, same shape FixedTimeController expects
 * @param turnFor        (node) => [null | { demand, weight }, ...] per road (0 arterial, 1 cross), the protected turn stage at that node
 * @param targetSpeedMps progression speed the offset chain is built for
 * @returns Map<nodeId, GreenWaveController>
 */
export function buildGreenWaveControllers(nodeInfos, arterialDemandFor, crossDemandFor, turnFor, targetSpeedMps) {
    const plans = nodeInfos.map((info) => {
        const turn = turnFor(info.node);
        const stages = buildStages(turn);
        return { stages, ratios: stageRatios(stages, arterialDemandFor(info.node), crossDemandFor(info.node), turn) };
    });

    // Oversaturated anywhere (Y >= 1) -> Webster is undefined for the critical node, so the
    // whole arterial falls back to the same fixed cycle FixedTimeController uses.
    let cycleLengthS;
    try {
        cycleLengthS = Math.max(...plans.map((p) => websterCycleFor(p.stages, p.ratios)));
    } catch {
        cycleLengthS = FALLBACK_CYCLE_S;
    }
    // Every node's minimum greens still have to fit inside the common cycle.
    cycleLengthS = Math.max(cycleLengthS, ...plans.map((p) => p.stages.reduce((sum, s) => sum + minGreenOf(s), 0) + lostTimeS(p.stages)));

    const controllers = new Map();
    let offsetS = 0;
    nodeInfos.forEach((info, i) => {
        if (i > 0) {
            // Along the arterial, not the previous node's distanceToNextM - a roundabout or stop between two signals isn't in nodeInfos.
            const prevDistanceM = info.node.sAlongM - nodeInfos[i - 1].node.sAlongM;
            offsetS += greenWaveOffset(prevDistanceM, targetSpeedMps) + startFromRestLagS(targetSpeedMps);
        }
        const { stages, ratios } = plans[i];
        const stageGreens = splitCommonCycle(cycleLengthS, stages, ratios);
        // The offset is where the arterial's through green opens, so a lead turn stage in front of it starts earlier.
        const leadS = stages[0].turn ? stageGreens[0] + YELLOW_S + ALL_RED_S : 0;
        controllers.set(info.node.id, new GreenWaveController({ offsetS: offsetS - leadS, cycleLengthS, stages, stageGreens }));
    });
    return controllers;
}

/**
 * One node's Webster split of the arterial's common cycle. The minimum-green floor takes its
 * time from the other stages rather than lengthening the cycle, so every node keeps the exact
 * common cycle the offsets are built on.
 */
function splitCommonCycle(cycleLengthS, stages, ratios) {
    return floorWithinCycle(stages, websterGreens(stages, ratios, cycleLengthS), cycleLengthS);
}

function mod(a, n) {
    return ((a % n) + n) % n;
}
