/**
 * routing/graph.js - the road network as destination routing sees it.
 *
 * Built from a constructed SimulationEngine rather than the raw corridor JSON,
 * so every movement in the graph is one the engine can actually drive: its
 * gates, their turn options filtered by lane use (_allowedTurnOptions()), the
 * joins it hands cars across, the partway peel-offs and slip roads. Pure - it
 * reads the engine's static network and never touches per-run state.
 *
 * Each road direction is a line of decision points ("stops") in driving
 * order: its gates, plus every point a peel-off or slip road leaves it
 * (`divergesFrom`). A state `${roadKey}#${k}` is a car on that road heading
 * for stop k; `${roadKey}#${stops.length}` is past the last one, heading for
 * the road's end. An arc's cost is the free-flow time from where the car
 * makes its choice to the next stop it reaches, plus a penalty for each
 * junction it goes through, so every cost is non-negative.
 *
 * Arc kinds:
 *   move  - straight on or a turn at a gate (`nodeId`, `movement`)
 *   pass  - through a gate that has no approach this way (the road only leaves it)
 *   peel  - onto a partway peel-off (`joinIndex`)
 *   slip  - onto a slip road (`joinIndex`, `slipGateNodeId`): the left turn at that gate
 *   stay  - past a peel/slip point without taking it
 *   join  - off the road's end onto the joined road
 *   exit  - off the road's end out of the network
 */
import { roadPointAt } from '../corridor.js';

/** Placeholder time lost per junction by control (s) - routing.nodePenaltyS overrides. */
export const DEFAULT_NODE_PENALTY_S = { signal: 20, roundabout: 5, allWayStop: 8, stop: 8 };
/** Placeholder extra cost of turning rather than going straight (s) - routing.turnPenaltyS overrides. Drivers prefer a straight run. */
export const DEFAULT_TURN_PENALTY_S = { left: 0, right: 0 };

/** A road end less than this past its last junction is the end of a T, not a way out. */
const MIN_EXIT_RUN_M = 1;

export function stateId(roadKey, index) {
    return `${roadKey}#${index}`;
}

function lanesAllow(slotLaneUse, movement) {
    return Boolean(slotLaneUse?.some((moves) => moves.includes(movement)));
}

/** The road key a turn option lands on. */
function optionRoadKey(option) {
    return option.carriagewayId ?? `${option.connectorId}:${option.dirKey}`;
}

/**
 * Every road direction the engine drives cars along, keyed the way joins key
 * them: an arterial's fwd by its id, its rev as `${id}:rev`, a connector's as
 * `${id}:${dirKey}`.
 */
function collectRoads(engine) {
    const roads = new Map();
    const add = (fields) => roads.set(fields.key, fields);
    for (const carriageway of engine.carriageways) {
        if (!carriageway.road.lanes) continue;
        add({
            key: carriageway.id,
            kind: 'arterial',
            roadId: carriageway.arterial.id,
            dirKey: carriageway.dirKey,
            name: carriageway.arterial.name,
            scope: carriageway.arterial.scope ?? 'arterial',
            road: carriageway.road,
            gates: carriageway.gates,
            lengthM: carriageway.lengthM,
            speedMps: carriageway.arterial.targetSpeedKph / 3.6,
            lanes: carriageway.road.lanes,
            spawns: !carriageway.noSpawn && !carriageway.fed,
            demand: carriageway.arterial.demand,
        });
    }
    for (const connector of engine.layout.connectors) {
        const dirs = engine.connectorDirs.get(connector.id);
        for (const dirKey of ['fwd', 'rev']) {
            const dir = dirs[dirKey];
            if (!dir.road.lanes) continue;
            add({
                key: `${connector.id}:${dirKey}`,
                kind: 'connector',
                roadId: connector.id,
                dirKey,
                name: connector.name ?? connector.id,
                scope: connector.scope ?? 'side',
                road: dir.road,
                gates: dir.gates,
                lengthM: connector.routeLengthM,
                speedMps: connector.targetSpeedKph / 3.6,
                lanes: dir.road.lanes,
                spawns: !dir.noSpawn && !dir.fed,
                demand: connector.demand,
            });
        }
    }
    return roads;
}

/**
 * @param engine        a constructed SimulationEngine (reset() not needed)
 * @param nodePenaltyS  seconds added for going through each junction, by control
 * @param turnPenaltyS  seconds added on top for a left or right turn there
 * @returns {{ roads, states, arcs, arcsFrom, origins, exits, intersections, anomalies }}
 */
export function buildRoutingGraph(engine, nodePenaltyS = DEFAULT_NODE_PENALTY_S, turnPenaltyS = DEFAULT_TURN_PENALTY_S) {
    const roads = collectRoads(engine);
    const joins = engine.layout.joins ?? [];
    const anomalies = [];

    for (const road of roads.values()) {
        const diverges = (engine.divergesFrom.get(road.key) ?? []).map((join) => ({
            type: join.slip ? 'slip' : 'peel',
            atM: join.fromAtM,
            join,
            joinIndex: joins.findIndex((j) => j.from.key === join.from.key && j.to.key === join.to.key && j.fromAtM === join.fromAtM),
        }));
        road.stops = [...road.gates.map((gate) => ({ type: 'gate', atM: gate.centreDistanceM, gate })), ...diverges].sort((a, b) => a.atM - b.atM);
    }

    /** The state a car entering `road` at `atM` is in: heading for the first stop still ahead. */
    const stateAt = (road, atM) => {
        const k = road.stops.findIndex((stop) => stop.atM > atM + 0.5);
        return k === -1 ? road.stops.length : k;
    };
    /** Free-flow time and distance from `atM` on `road` to the stop (or end) state `k` heads for. */
    const runTo = (road, atM, k) => {
        const toM = k < road.stops.length ? road.stops[k].atM : road.lengthM;
        const runM = Math.max(0, toM - atM);
        return { runM, runS: runM / road.speedMps };
    };

    const arcs = [];
    const states = new Map();
    for (const road of roads.values()) {
        for (let k = 0; k <= road.stops.length; k += 1) states.set(stateId(road.key, k), { id: stateId(road.key, k), roadKey: road.key, index: k, stop: road.stops[k] ?? null });
    }

    const addArc = (from, fields, toRoad, entryM, penaltyS = 0) => {
        const k = stateAt(toRoad, entryM);
        const { runM, runS } = runTo(toRoad, entryM, k);
        arcs.push({ from, to: stateId(toRoad.key, k), ...fields, entryM, costS: penaltyS + runS, runS, lengthM: runM });
    };

    for (const road of roads.values()) {
        road.stops.forEach((stop, k) => {
            const from = stateId(road.key, k);
            if (stop.type !== 'gate') {
                const toRoad = roads.get(stop.join.to.key);
                addArc(from, { kind: stop.type, joinIndex: stop.joinIndex, slipGateNodeId: stop.join.gate?.node.id ?? null }, toRoad, stop.join.toAtM ?? 0);
                addArc(from, { kind: 'stay', joinIndex: stop.joinIndex }, road, stop.atM);
                return;
            }

            const { gate } = stop;
            if (!gate.approach) {
                addArc(from, { kind: 'pass', nodeId: gate.node.id }, road, stop.atM);
                return;
            }
            const penaltyS = nodePenaltyS[gate.node.control] ?? 0;
            if (!gate.approach.noStraight && lanesAllow(gate.slotLaneUse, 'straight')) {
                addArc(from, { kind: 'move', nodeId: gate.node.id, movement: 'straight' }, road, stop.atM, penaltyS);
            }
            for (const option of engine._allowedTurnOptions(gate)) {
                const toRoad = roads.get(optionRoadKey(option));
                if (!toRoad) {
                    anomalies.push(`${road.key} at ${gate.node.id}: ${option.movement} turn into ${optionRoadKey(option)}, which has no lanes`);
                    continue;
                }
                addArc(from, { kind: 'move', nodeId: gate.node.id, movement: option.movement, option }, toRoad, option.entryDistanceM, penaltyS + (turnPenaltyS[option.movement] ?? 0));
            }
            // Round a roundabout and back the way it came (engine.js's _uturnOption()).
            const { uturnOption } = gate;
            if (uturnOption && roads.has(optionRoadKey(uturnOption))) {
                addArc(from, { kind: 'move', nodeId: gate.node.id, movement: 'uturn', option: uturnOption }, roads.get(optionRoadKey(uturnOption)), uturnOption.entryDistanceM, penaltyS + (turnPenaltyS.uturn ?? 0));
            }
        });

        // The road's end: onto the joined road, or out of the network.
        const end = stateId(road.key, road.stops.length);
        const join = engine.joinsFrom.get(road.key);
        if (join) {
            addArc(end, { kind: 'join', joinIndex: joins.findIndex((j) => j.from.key === road.key && j.fromAtM == null) }, roads.get(join.to.key), join.toAtM ?? 0);
        } else if (road.lengthM - (road.gates.at(-1)?.centreDistanceM ?? 0) >= MIN_EXIT_RUN_M) {
            arcs.push({ from: end, to: `exit:${road.key}`, kind: 'exit', costS: 0, runS: 0, lengthM: 0 });
        }
    }

    const arcsFrom = new Map();
    for (const arc of arcs) {
        if (!arcsFrom.has(arc.from)) arcsFrom.set(arc.from, []);
        arcsFrom.get(arc.from).push(arc);
    }

    const origins = [...roads.values()]
        .filter((road) => road.spawns)
        .map((road) => {
            const { runM, runS } = runTo(road, 0, 0);
            return { roadKey: road.key, stateId: stateId(road.key, 0), point: roadPointAt(road.road, 0).point, firstRunM: runM, firstRunS: runS };
        });
    const exits = arcs
        .filter((arc) => arc.kind === 'exit')
        .map((arc) => {
            const road = roads.get(arc.to.slice('exit:'.length));
            return { id: arc.to, roadKey: road.key, point: roadPointAt(road.road, road.lengthM).point };
        });
    const intersections = [...engine.nodesInfo.values()].map((info) => ({ id: info.node.id, control: info.node.control, point: info.node.point }));

    return { roads, states, arcs, arcsFrom, origins, exits, intersections, anomalies };
}

/** Free-flow shortest costs from `sourceId` to every reachable state/exit (Dijkstra, binary heap). */
export function shortestFrom(graph, sourceId, costOf = (arc) => arc.costS) {
    const dist = new Map([[sourceId, 0]]);
    const prev = new Map();
    const heap = [[0, sourceId]];
    const swap = (i, j) => ([heap[i], heap[j]] = [heap[j], heap[i]]);
    const push = (item) => {
        heap.push(item);
        for (let i = heap.length - 1; i > 0; ) {
            const p = (i - 1) >> 1;
            if (heap[p][0] <= heap[i][0]) break;
            swap(i, p);
            i = p;
        }
    };
    const pop = () => {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
            heap[0] = last;
            for (let i = 0; ; ) {
                const l = 2 * i + 1;
                let m = i;
                if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
                if (l + 1 < heap.length && heap[l + 1][0] < heap[m][0]) m = l + 1;
                if (m === i) break;
                swap(i, m);
                i = m;
            }
        }
        return top;
    };

    while (heap.length) {
        const [d, id] = pop();
        if (d > dist.get(id)) continue;
        for (const arc of graph.arcsFrom.get(id) ?? []) {
            const nd = d + costOf(arc);
            if (nd < (dist.get(arc.to) ?? Infinity)) {
                dist.set(arc.to, nd);
                prev.set(arc.to, arc);
                push([nd, arc.to]);
            }
        }
    }
    return { dist, prev };
}

/** The arcs from the source of `prev` to `targetId`, in driving order. */
export function pathTo(prev, targetId) {
    const path = [];
    for (let arc = prev.get(targetId); arc; arc = prev.get(arc.from)) path.push(arc);
    return path.reverse();
}
