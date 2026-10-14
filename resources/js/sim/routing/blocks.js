/**
 * routing/blocks.js - a routing block's driving directions, found on the
 * routing graph (routing/graph.js).
 *
 * A block names two points (routing/config.js); it runs in a direction when a
 * car can drive from one point to the other without turning - along a road,
 * through any junction it passes straight on, and across a join onto the road
 * that carries on (a block may span two config roads, e.g. Jan Shoba's
 * northbound carriageway from Francis Baard to Pretorius). A one-way block
 * runs one way, a two-way block both. The destination a car is given is one
 * of these directions: `${block.id}:${compass}`.
 */
import { compassDirection, roadPointAt } from '../corridor.js';
import { stateId } from './graph.js';

/** More joins than this between a block's two points means the points don't belong together. */
const MAX_HOPS = 4;
const COMPASS_LETTER = { northbound: 'N', southbound: 'S', eastbound: 'E', westbound: 'W' };

/** Where `point` sits along `road` (graph road direction), or null if it isn't on it. */
function positionOn(road, point) {
    const stop = road.stops.find((s) => s.type === 'gate' && s.gate.node.id === point);
    if (stop) return stop.atM;
    const [roadId, end] = point.split(':');
    if (roadId !== road.roadId || !end) return null;
    const atStart = (end === 'start') === (road.dirKey === 'fwd');
    return atStart ? 0 : road.lengthM;
}

/**
 * Drives from `atM` on `road` towards `target` without turning. Returns the
 * stretch of each road it covers, or null if `target` isn't straight ahead.
 */
function walk(graph, road, atM, target) {
    const pieces = [];
    for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
        const targetM = positionOn(road, target);
        const reached = targetM != null && targetM > atM + 0.5;
        const toM = reached ? targetM : road.lengthM;
        pieces.push({
            roadKey: road.key,
            fromM: atM,
            toM,
            /** Junctions with a stop line driven through on the way - a block should have none. */
            via: road.stops.filter((s) => s.type === 'gate' && s.gate.approach && s.atM > atM + 0.5 && s.atM < toM - 0.5).map((s) => s.gate.node.id),
        });
        // A road the block only touches at its end (the shared junction where two config roads meet) isn't part of it.
        if (reached) return pieces.filter((p) => p.toM - p.fromM >= 0.5);
        const join = (graph.arcsFrom.get(stateId(road.key, road.stops.length)) ?? []).find((arc) => arc.kind === 'join');
        if (!join) return null;
        road = graph.roads.get(graph.states.get(join.to).roadKey);
        atM = join.entryM;
    }
    return null;
}

/** The road direction and distance `alongM` into a walked block. */
export function pointAlong(pieces, alongM) {
    let left = alongM;
    for (const piece of pieces) {
        const runM = piece.toM - piece.fromM;
        if (left <= runM) return { roadKey: piece.roadKey, atM: piece.fromM + left };
        left -= runM;
    }
    const last = pieces.at(-1);
    return { roadKey: last.roadKey, atM: last.toM };
}

/**
 * @returns per block: `{ ...block, dirs: [{ id, blockId, compass, pieces, lengthM, via, midpoint }], weight }`
 *          plus `problems` (blocks with no direction, or with junctions inside them)
 */
export function resolveBlocks(graph, routing) {
    const problems = [];
    const blocks = routing.blocks.map((block) => {
        const dirs = [];
        for (const [a, b] of [[block.from, block.to], [block.to, block.from]]) {
            for (const road of graph.roads.values()) {
                const atM = positionOn(road, a);
                if (atM == null) continue;
                const pieces = walk(graph, road, atM, b);
                if (!pieces) continue;
                const lengthM = pieces.reduce((s, p) => s + (p.toM - p.fromM), 0);
                const midpoint = pointAlong(pieces, lengthM / 2);
                // Named by where it heads overall, not at its middle - a block round a bend (Jan Shoba's merge) still reads N/S.
                const start = roadPointAt(graph.roads.get(pieces[0].roadKey).road, pieces[0].fromM).point;
                const end = roadPointAt(graph.roads.get(pieces.at(-1).roadKey).road, pieces.at(-1).toM).point;
                const compass = COMPASS_LETTER[compassDirection({ x: end.x - start.x, y: end.y - start.y })];
                if (dirs.some((d) => d.compass === compass)) continue;
                dirs.push({ id: `${block.id}:${compass}`, blockId: block.id, compass, pieces, lengthM, via: pieces.flatMap((p) => p.via), midpoint });
            }
        }
        if (!dirs.length) problems.push(`${block.id}: no way to drive from ${block.from} to ${block.to} (or back) without turning`);
        for (const dir of dirs) if (dir.via.length) problems.push(`${dir.id}: passes junction(s) ${dir.via.join(', ')} - split it there`);
        const lengthM = dirs.length ? Math.max(...dirs.map((d) => d.lengthM)) : 0;
        return { ...block, dirs, lengthM, weight: block.tier * lengthM * block.weightShare };
    });
    return { blocks, problems };
}
