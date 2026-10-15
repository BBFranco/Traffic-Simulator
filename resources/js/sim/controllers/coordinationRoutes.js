/**
 * controllers/coordinationRoutes.js - coordination along a road that the layout models as connectors rather than as
 * an arterial: Jan Shoba, a major road (`scope: "arterial"`) that crosses every arterial it meets, so at each of its
 * junctions it is the cross street (phase 1). planCoordination() (greenWave.js) can only coordinate phase 0 along one
 * arterial; a route can coordinate either phase, along chains of connector directions joined end to end, and in both
 * directions at once.
 *
 * A route is planned exactly like an arterial - each junction's Webster split, the critical junction's cycle as the
 * common one, half-cycling - in "swapped" phase space where the coordinated road is phase 0, then its stages are
 * swapped back. Only the offsets differ: they come from the route's directed chains (routeOffsets()), so a two-way
 * section gets offsets that serve both directions, not just the one it happens to be listed in.
 */
import { greenWaveOffset } from '../equations.js';
import { ALL_RED_S, YELLOW_S, buildStages, fixedTimeGreens, stageRatios } from './phasePlan.js';
import { splitCommonCycle, startFromRestLagS } from './greenWave.js';

const OFFSET_STEP_S = 0.25;

function mod(a, n) {
    return ((a % n) + n) % n;
}

/** Shortest way round the cycle between two cycle positions. */
function circularGap(a, b, cycleS) {
    const d = mod(a - b, cycleS);
    return Math.min(d, cycleS - d);
}

/**
 * Each junction's offset - when its coordinated green should open - from the route's directed chains. Along a chain a
 * platoon from one signal should meet the next one's green after the link's travel time plus the start-from-rest lag
 * (greenWave.js). A link travelled in both directions (a two-way section) wants +t one way and -t' the other: the
 * offset is the weighted compromise, the cycle position with the least squared circular distance to every direction's
 * wish - with equal weights the classic two-way answer, both directions together or half a cycle apart.
 *
 * @param chains  [{ nodeIds: [...in driving order], gapsM: [...distance between consecutive nodes], weight }]
 * @returns Map<nodeId, offsetS>  offsets within [0, cycleS); the first chain's first node at 0
 */
export function routeOffsets(chains, cycleS, targetSpeedMps) {
    const travelS = (gapM) => greenWaveOffset(gapM, targetSpeedMps) + startFromRestLagS(targetSpeedMps);
    /** "a|b" (sorted) -> wishes for offset(b) - offset(a), each { fromA, wishS, weight }. */
    const links = new Map();
    const neighbours = new Map();
    const link = (a, b, wishS, weight) => {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const key = `${lo}|${hi}`;
        if (!links.has(key)) links.set(key, []);
        // Stored as a wish for offset(hi) - offset(lo).
        links.get(key).push({ wishS: a === lo ? wishS : -wishS, weight });
        for (const [x, y] of [[a, b], [b, a]]) {
            if (!neighbours.has(x)) neighbours.set(x, new Set());
            neighbours.get(x).add(y);
        }
    };
    for (const chain of chains) {
        for (let i = 0; i < chain.nodeIds.length - 1; i += 1) link(chain.nodeIds[i], chain.nodeIds[i + 1], travelS(chain.gapsM[i]), chain.weight ?? 1);
    }

    const offsets = new Map();
    const start = chains.find((chain) => chain.nodeIds.length)?.nodeIds[0];
    if (start === undefined) return offsets;
    offsets.set(start, 0);
    const queue = [start];
    while (queue.length) {
        const a = queue.shift();
        for (const b of neighbours.get(a) ?? []) {
            if (offsets.has(b)) continue;
            const [lo, hi] = a < b ? [a, b] : [b, a];
            const wishes = links.get(`${lo}|${hi}`);
            // Best offset(hi) - offset(lo) on a fine grid round the cycle.
            let best = 0;
            let bestCost = Infinity;
            for (let x = 0; x < cycleS; x += OFFSET_STEP_S) {
                const cost = wishes.reduce((sum, w) => sum + w.weight * circularGap(x, w.wishS, cycleS) ** 2, 0);
                if (cost < bestCost - 1e-9) [best, bestCost] = [x, cost];
            }
            const delta = a === lo ? best : -best;
            offsets.set(b, mod(offsets.get(a) + delta, cycleS));
            queue.push(b);
        }
    }
    return offsets;
}

/**
 * The route's plan - planCoordination()'s shape, so the self-tuner and the controllers take it unchanged.
 *
 * @param route            { nodeInfos, coordinatedPhase, chains, targetSpeedMps }
 * @param arterialDemandFor / crossDemandFor / turnFor   as planCoordination() takes them, by real phase
 * @returns { criticalCycleS, commonCycleS, nodes: Map<nodeId, { offsetS, cycleLengthS, stages, stageGreens, ownCycleS, coordinatedPhase }> }
 */
export function planRoute(route, arterialDemandFor, crossDemandFor, turnFor, { commonCycleS = null } = {}) {
    const phase = route.coordinatedPhase;
    // The coordinated road's demand and turn stage as "phase 0", the other as "phase 1" - then planned like an arterial.
    const swap = (pair) => (phase === 1 ? [pair[1], pair[0]] : pair);
    const plans = route.nodeInfos.map((info) => {
        const turn = swap(turnFor(info.node));
        const [coordinated, other] = swap([arterialDemandFor(info.node), crossDemandFor(info.node)]);
        const stages = buildStages(turn);
        return {
            info,
            stages,
            ratios: stageRatios(stages, coordinated, other, turn),
            ownCycleS: fixedTimeGreens(stages, coordinated, other, turn).cycleLengthS,
        };
    });
    const criticalCycleS = Math.max(...plans.map((p) => p.ownCycleS));
    const cycleLengthS = commonCycleS ?? criticalCycleS;
    const offsets = routeOffsets(route.chains, cycleLengthS, route.targetSpeedMps);

    const nodes = new Map();
    for (const { info, stages, ratios, ownCycleS } of plans) {
        const nodeCycleS = ownCycleS <= cycleLengthS / 2 ? cycleLengthS / 2 : cycleLengthS;
        const stageGreens = splitCommonCycle(nodeCycleS, stages, ratios);
        // The offset is where the coordinated through green opens, so a lead turn stage in front of it starts earlier.
        const leadS = stages[0].turn ? stageGreens[0] + YELLOW_S + ALL_RED_S : 0;
        nodes.set(info.node.id, {
            offsetS: (offsets.get(info.node.id) ?? 0) - leadS,
            cycleLengthS: nodeCycleS,
            stages: stages.map((stage) => ({ ...stage, phase: phase === 1 ? 1 - stage.phase : stage.phase })),
            stageGreens,
            ownCycleS,
            coordinatedPhase: phase,
        });
    }
    return { criticalCycleS, commonCycleS: cycleLengthS, nodes };
}

/**
 * SCATS-style marriage over a route's chains - selfTuning.js's chooseMarried() rule, per chain link: a link marries
 * while the mean busiest-lane coordinated flow at its two ends is at least `marryFlowPerLaneMin` (`divorceRatio` of it
 * once married) and a platoon crosses it within `marryMaxTravelS`.
 *
 * @param q              (nodeId) => busiest-lane flow on the coordinated road there (veh/min per lane)
 * @param previousLinks  link keys ("a|b") married at the last decision
 * @returns { nodes: Set<nodeId>, links: Set<"a|b"> }
 */
export function chooseMarriedOnChains(chains, nodeIds, q, targetSpeedMps, coord, previousLinks = new Set()) {
    const nodes = new Set();
    const links = new Set();
    if (!coord.selective) for (const nodeId of nodeIds) nodes.add(nodeId);
    for (const chain of chains) {
        for (let i = 0; i < chain.nodeIds.length - 1; i += 1) {
            const [a, b] = [chain.nodeIds[i], chain.nodeIds[i + 1]];
            const key = `${a}|${b}`;
            const threshold = coord.marryFlowPerLaneMin * (previousLinks.has(key) ? coord.divorceRatio : 1);
            const travelS = chain.gapsM[i] / targetSpeedMps;
            if (coord.selective && (travelS > coord.marryMaxTravelS || (q(a) + q(b)) / 2 < threshold)) continue;
            links.add(key);
            nodes.add(a);
            nodes.add(b);
        }
    }
    return { nodes, links };
}
