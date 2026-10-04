/**
 * controllers/phasePlan.js - the stage sequence shared by the fixed-time and green-wave controllers.
 *
 * A junction cycles its two roads (phase 0 the arterial, phase 1 the cross street). A road with a
 * protected turn (a node's `turnPhases`) gets a lead stage in front of its through green: only
 * the turn lanes it names go, with the opposing through traffic held, then the road's through
 * green follows (the turn lanes keep going on it, permitted as before). The stages in cycle
 * order are therefore [turn 0?, through 0, turn 1?, through 1].
 *
 * Webster's formulas (equations.js) are used unchanged - a turn stage is one more phase in them,
 * with y = q / s for its busiest turn lane.
 */
import { websterOptimumCycle, websterGreenSplit } from '../equations.js';

export const LOST_TIME_PER_PHASE_S = 4;
export const YELLOW_S = 3;
export const ALL_RED_S = 1;
/** Floor so a near-zero-demand phase (e.g. an unmodelled cross stub) still gets a legal minimum green. */
export const MIN_GREEN_S = 6;
export const MIN_TURN_GREEN_S = 6;
/** Used when Webster's method is undefined (Y >= 1, oversaturated) - keep cycling rather than throw mid-run. */
export const FALLBACK_CYCLE_S = 120;
/** A turn stage's green in that fallback cycle, before its weight. */
export const FALLBACK_TURN_GREEN_S = 12;

/**
 * The signal-timing rules a run used - stamped on every run (runHeadless.js's rawConfig) so a
 * sensitivity batch with different rules can never be read as the baseline. The baseline is real
 * q, the turn `weight` only on the minimum green; `websterTurnWeight` (a sensitivity run only)
 * also scales a protected turn's q by its weight before Webster (engine.js's _turnStagesAt()).
 */
export function controllerConfigFor({ websterTurnWeight = false } = {}) {
    return {
        websterTurnInput: websterTurnWeight ? 'q-x-weight' : 'real-q',
        turnWeightActsOn: websterTurnWeight ? 'min-green+webster-q' : 'min-green',
        minGreenS: MIN_GREEN_S,
        minTurnGreenS: MIN_TURN_GREEN_S,
        lostTimePerPhaseS: LOST_TIME_PER_PHASE_S,
        fallbackCycleS: FALLBACK_CYCLE_S,
    };
}

export function flowRatio(demand) {
    if (!demand) return 0;
    const qPerHour = demand.spawnRatePerLanePerMin * 60;
    return qPerHour / demand.saturationFlowPerLanePerHour;
}

/** The stages in cycle order for `turn` - per road, null or `{ demand, weight }` - as `{ phase, turn, weight? }`. */
export function buildStages(turn) {
    const stages = [];
    for (const phase of [0, 1]) {
        if (turn[phase]) stages.push({ phase, turn: true, weight: turn[phase].weight });
        stages.push({ phase, turn: false });
    }
    return stages;
}

/** Each stage's flow ratio: the road's own for a through stage, the busiest turn lane's for a turn stage. Only real q goes into Webster - a turn's `weight` acts on its minimum green (minGreenOf()), not on its share. */
export function stageRatios(stages, arterialDemand, crossDemand, turn) {
    const through = [flowRatio(arterialDemand), flowRatio(crossDemand)];
    return stages.map((s) => (s.turn ? flowRatio(turn[s.phase].demand) : through[s.phase]));
}

export function lostTimeS(stages) {
    return LOST_TIME_PER_PHASE_S * stages.length;
}

/** A busy turn (weight above 1) is held proportionally longer even when its Webster green would be the minimum. */
export function minGreenOf(stage) {
    return stage.turn ? MIN_TURN_GREEN_S * stage.weight : MIN_GREEN_S;
}

/** Webster's optimum cycle for `stages` - throws like websterOptimumCycle() when oversaturated. */
export function websterCycleFor(stages, ratios) {
    return websterOptimumCycle(lostTimeS(stages), ratios);
}

/** The oversaturated fallback's greens: every turn stage its fixed share, the through stages splitting the rest of the cycle evenly. */
export function fallbackGreens(stages, turn, cycleLengthS = FALLBACK_CYCLE_S) {
    const effective = cycleLengthS - lostTimeS(stages);
    const turnGreens = stages.map((s) => (s.turn ? FALLBACK_TURN_GREEN_S * turn[s.phase].weight : 0));
    const throughCount = stages.filter((s) => !s.turn).length;
    const throughGreen = (effective - turnGreens.reduce((sum, g) => sum + g, 0)) / throughCount;
    return stages.map((s, i) => (s.turn ? turnGreens[i] : throughGreen));
}

/** Webster's green split of a cycle of `cycleLengthS` over `stages`, no floors applied. */
export function websterGreens(stages, ratios, cycleLengthS) {
    const L = lostTimeS(stages);
    const Y = ratios.reduce((sum, y) => sum + y, 0);
    return Y > 0 ? websterGreenSplit(cycleLengthS, L, ratios) : stages.map(() => (cycleLengthS - L) / stages.length);
}

/**
 * `greens` squeezed into a fixed cycle: any stage under its minimum is lifted to it and the
 * rest give up that time in proportion, so the cycle keeps its exact length.
 */
export function floorWithinCycle(stages, greens, cycleLengthS) {
    const effective = cycleLengthS - lostTimeS(stages);
    const result = greens.slice();
    const pinned = new Set();
    for (let pass = 0; pass < stages.length; pass += 1) {
        const free = stages.map((_, i) => i).filter((i) => !pinned.has(i));
        const budget = effective - [...pinned].reduce((sum, i) => sum + result[i], 0);
        const total = free.reduce((sum, i) => sum + greens[i], 0);
        let changed = false;
        for (const i of free) {
            result[i] = total > 0 ? (greens[i] / total) * budget : budget / free.length;
            if (result[i] < minGreenOf(stages[i])) {
                result[i] = minGreenOf(stages[i]);
                pinned.add(i);
                changed = true;
            }
        }
        if (!changed) break;
    }
    return result;
}
