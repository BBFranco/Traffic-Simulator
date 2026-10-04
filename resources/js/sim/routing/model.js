/**
 * routing/model.js - everything destination routing needs at run time, built
 * once from a constructed engine: the graph, the blocks and their driveways,
 * the OD table, and the lookups the engine's decision points use.
 */
import { resolveBlocks } from './blocks.js';
import { buildDriveways } from './driveways.js';
import { buildRoutingGraph, stateId } from './graph.js';
import { buildOdTable } from './odTable.js';

/** Fixed seed for the route variants' cost noise - the variants are a property of the network, not of a run. */
const ROUTE_VARIANT_SEED = 1;

export function buildRoutingModel(engine) {
    const routing = engine.layout.routing;
    const graph = buildRoutingGraph(engine, routing.nodePenaltyS, routing.turnPenaltyS);
    const { blocks, problems } = resolveBlocks(graph, routing);
    const { driveways, dirs: drivewayDirs, handOffs } = buildDriveways(engine, graph, blocks, routing);
    const od = buildOdTable(graph, blocks, drivewayDirs, routing, ROUTE_VARIANT_SEED);

    /** The graph state a car is in as each gate becomes its next decision, and as each peel-off/slip point does. */
    const stateOfGate = new Map();
    const stateOfDiverge = new Map();
    for (const road of graph.roads.values()) {
        road.stops.forEach((stop, k) => {
            if (stop.type === 'gate') stateOfGate.set(stop.gate, stateId(road.key, k));
            else stateOfDiverge.set(stop.join, stateId(road.key, k));
        });
    }

    const destinationsById = new Map(od.destinations.map((d) => [d.id, d]));
    const blockDirsById = new Map(blocks.flatMap((b) => b.dirs).map((d) => [d.id, d]));
    const originsByRoadKey = new Map(od.origins.map((o) => [o.roadKey, o]));
    /** Per origin, its destinations' cumulative shares - a uniform draw picks one. */
    for (const origin of od.origins) {
        let sum = 0;
        origin.cumulative = origin.shares.map((s) => (sum += s.share));
    }

    /** From each state, the exit a car that can no longer reach its destination falls back to (least free-flow time). */
    const exitFallback = new Map();
    const exits = od.destinations.filter((d) => d.kind === 'exit');
    for (const id of graph.states.keys()) {
        let best = null;
        for (const exit of exits) {
            const next = od.variants[0].get(exit.id);
            if (!next.has(id)) continue;
            let timeS = 0;
            for (let at = id, guard = 0; at !== exit.target && guard < 200; guard += 1) {
                const arc = next.get(at);
                timeS += arc.costS;
                at = arc.to;
            }
            if (!best || timeS < best.timeS) best = { id: exit.id, timeS };
        }
        if (best) exitFallback.set(id, best.id);
    }

    /** Per block direction, every graph state a car on that block is in - from where it enters to the stop past its end. */
    const blockStates = new Map();
    for (const dir of blockDirsById.values()) {
        const states = new Set();
        for (const piece of dir.pieces) {
            const road = graph.roads.get(piece.roadKey);
            const stateAt = (atM) => {
                const k = road.stops.findIndex((s) => s.atM > atM + 0.5);
                return k === -1 ? road.stops.length : k;
            };
            for (let k = stateAt(piece.fromM); k <= stateAt(piece.toM - 1); k += 1) states.add(stateId(road.key, k));
        }
        blockStates.set(dir.id, states);
    }

    /**
     * Per gate, the routed design flow (veh/min, sinusoid mean) reaching its stop line by movement - what
     * fixed-time and green-wave timing read in destination mode instead of the turn chances. Cars that
     * took a slip road ahead of the gate aren't in it, the same convention as the turn-chance flows.
     */
    const movementFlowByGate = new Map();
    for (const [gate, id] of stateOfGate) {
        const moves = od.expectedMovementFlow.get(`${graph.states.get(id).roadKey}@${gate.node.id}`) ?? {};
        const flow = { straight: moves.straight?.meanPerMin ?? 0, left: moves.left?.meanPerMin ?? 0, right: moves.right?.meanPerMin ?? 0 };
        flow.total = flow.straight + flow.left + flow.right;
        movementFlowByGate.set(gate, flow);
    }

    /** Which exit a car clearing off the end of a road (by its road geometry object) has reached. */
    const exitByRoad = new Map(graph.exits.map((exit) => [graph.roads.get(exit.roadKey).road, exit.id]));

    return { routing, graph, blocks, problems, driveways, drivewayDirs, handOffs, od, stateOfGate, stateOfDiverge, destinationsById, blockDirsById, originsByRoadKey, exitFallback, exitByRoad, blockStates, movementFlowByGate };
}
