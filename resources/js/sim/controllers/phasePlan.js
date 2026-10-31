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
import { ADAPTIVE_DEFAULTS, websterOptimumCycle, websterGreenSplit } from '../equations.js';

export const LOST_TIME_PER_PHASE_S = 4;
export const YELLOW_S = 3;
export const ALL_RED_S = 1;
/**
 * A main (through) stage's minimum green: SARTSM Vol 3 §6.13.3's safety minimum of 7 s (2026-10-23, was 6 s). Also the
 * floor for a near-zero-demand phase (e.g. an unmodelled cross stub). A turn stage's 6 s is above SARTSM's 4 s.
 */
export const MIN_GREEN_S = 7;
export const MIN_TURN_GREEN_S = 6;
/** No signal cycle shorter than this: SARTSM Vol 3 §6.13.2 - a shorter one "would not meet minimum green requirements". */
export const MIN_CYCLE_S = 30;
/** SARTSM Vol 3 §6.13.2's longest cycle - "or drivers assume the signals have failed". The adaptive maximum-green sensitivity's cap (sartsmMaxGreens()). */
export const MAX_CYCLE_S = 120;
/** Adaptive control's longest protected-turn green before its weight (controllers/adaptive.js) - it also ends as soon as its lane stops actuating the detector. */
export const MAX_TURN_GREEN_S = 25;
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
export function controllerConfigFor({ websterTurnWeight = false, fixedFloorS = 0, adaptiveMaxGreen = 'default' } = {}) {
    return {
        ...(fixedFloorS ? { fixedTimeFloorS: fixedFloorS } : {}),
        ...(adaptiveMaxGreen === 'sartsm' ? { adaptiveMaxGreen: 'sartsm-webster-c120' } : {}),
        websterTurnInput: websterTurnWeight ? 'q-x-weight' : 'real-q',
        turnWeightActsOn: websterTurnWeight ? 'min-green+webster-q' : 'min-green',
        minGreenS: MIN_GREEN_S,
        minTurnGreenS: MIN_TURN_GREEN_S,
        minCycleS: MIN_CYCLE_S,
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

/**
 * A junction's own fixed-time plan: Webster's cycle and split on real q, every stage then lifted to
 * its minimum green - the lift adds to the cycle. A cycle still under MIN_CYCLE_S is stretched to it,
 * Webster's split of that longer cycle (floorWithinCycle()). `practiceFloorS` (a fixed-time sensitivity run only,
 * dissertation plan step 14: 50 s or 60 s) raises that floor; 0 keeps the SARTSM 30 s. Oversaturated (Webster undefined): the
 * fallback greens, lifted the same way. Fixed-time runs exactly this; green wave takes its arterial's
 * longest such cycle as the common one, so no junction is squeezed below what it would run on its own.
 */
export function fixedTimeGreens(stages, arterialDemand, crossDemand, turn, practiceFloorS = 0) {
    const floorS = Math.max(MIN_CYCLE_S, practiceFloorS);
    const ratios = stageRatios(stages, arterialDemand, crossDemand, turn);
    let greens;
    try {
        greens = websterGreens(stages, ratios, websterCycleFor(stages, ratios));
    } catch {
        greens = fallbackGreens(stages, turn);
    }
    const lifted = greens.map((g, i) => Math.max(minGreenOf(stages[i]), g));
    const cycleLengthS = lifted.reduce((sum, g) => sum + g, 0) + lostTimeS(stages);
    if (cycleLengthS >= floorS) return { greens: lifted, cycleLengthS };
    return { greens: floorWithinCycle(stages, websterGreens(stages, ratios, floorS), floorS), cycleLengthS: floorS };
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

/** An adaptive stage's usual maximum green: 45 s for a through green, 25 s x weight for a protected turn. */
export function defaultAdaptiveMaxGreen(stage) {
    return stage.turn ? MAX_TURN_GREEN_S * stage.weight : ADAPTIVE_DEFAULTS.maxGreen;
}

/**
 * The adaptive maximum-green sensitivity (dissertation plan Phase 4, item 6): SARTSM Vol 3 §7.5.2(3) - in heavy flow
 * an actuated signal runs to its maxima, so they are set as for fixed-time control, within §6.13.2's 120 s cycle.
 * A junction whose usual maxima plus lost time fit in MAX_CYCLE_S keeps them (every two-stage junction: 2 x 45 + 8 =
 * 98 s); §7.5.2(2)'s 30-60 s range still applies there. Otherwise the maxima are its fixed-time Webster greens
 * (fixedTimeGreens(), SARTSM minimums and the oversaturated fallback included) scaled so they plus lost time make
 * exactly MAX_CYCLE_S, each held between its minimum (adaptive's 8 s, a turn's 6 s x weight) and its usual maximum,
 * the time a held stage frees or takes shared over the rest. Minimums win should they alone need more than 120 s.
 * Per stage, in buildStages() order.
 */
export function sartsmMaxGreens(stages, arterialDemand, crossDemand, turn) {
    const usual = stages.map(defaultAdaptiveMaxGreen);
    const budget = MAX_CYCLE_S - lostTimeS(stages);
    if (usual.reduce((sum, g) => sum + g, 0) <= budget) return usual;
    const { greens } = fixedTimeGreens(stages, arterialDemand, crossDemand, turn);
    const floors = stages.map((s) => (s.turn ? MIN_TURN_GREEN_S * s.weight : ADAPTIVE_DEFAULTS.minGreen));
    return sharesWithin(greens, floors, usual, budget);
}

/** `budget` split in proportion to `weights`, each share held within [floors[i], caps[i]] - held shares pinned, the rest re-split. */
function sharesWithin(weights, floors, caps, budget) {
    const result = weights.slice();
    const pinned = new Set();
    for (let pass = 0; pass < weights.length; pass += 1) {
        const free = weights.map((_, i) => i).filter((i) => !pinned.has(i));
        const left = budget - [...pinned].reduce((sum, i) => sum + result[i], 0);
        const total = free.reduce((sum, i) => sum + weights[i], 0);
        let changed = false;
        for (const i of free) {
            const share = total > 0 ? (weights[i] / total) * left : left / free.length;
            result[i] = Math.min(caps[i], Math.max(floors[i], share));
            if (result[i] !== share) {
                pinned.add(i);
                changed = true;
            }
        }
        if (!changed) break;
    }
    return result;
}
