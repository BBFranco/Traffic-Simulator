/**
 * routing/driveways.js - where along each routing block cars can pull off,
 * derived from the layout (no driveway geometry is stored in the config).
 *
 * A block has two physical sides. Side "A" is the kerb on the left of the
 * block's first direction (left-hand traffic: the kerb side), side "B" the
 * one opposite - on a two-way block, the other direction's kerb. Each side
 * gets 1, 2 or 3 driveways by tier (<= 2, 3, >= 4), spaced evenly over the
 * stretch left once the exclusion zones near junctions, pockets, merges,
 * peel-offs and roundabouts are taken out.
 *
 * Which driveways a direction of travel can use:
 *  - its own kerb, always
 *  - the far side on a one-way block (no traffic to cross)
 *  - the far side on a two-way block without a median, crossing the oncoming
 *    lane - or with a median listed in `routing.crossableMedianRoads`
 *  - never the far side across any other median
 *
 * A direction left with no usable driveway hands its weight on (handOff):
 * to the nearest block downstream on the same road, else the nearest
 * upstream one.
 */
import { TURN_LANE_TAPER_M, roadPointAt } from '../corridor.js';
import { pointAlong } from './blocks.js';

/** Clear distance kept from a stop line, beyond the turn pocket and its taper (m). */
const STOP_LINE_CLEAR_M = 25;
const POCKET_MARGIN_M = 10;
/** Clear distance kept from a roundabout's entry or exit - a car waiting to turn in can't queue back into the ring (m). */
const ROUNDABOUT_CLEAR_M = 60;
/** Clear distance either side of a merge, peel-off or slip-road point (m). */
const JOIN_CLEAR_M = 30;
/** Clear distance from a road end that leaves the map (m). */
const ROAD_END_CLEAR_M = 10;
/** Closest two driveways on one side may be (m). */
const MIN_SPACING_M = 15;

export function drivewaysForTier(tier) {
    return tier <= 2 ? 1 : tier < 4 ? 2 : 3;
}

/** Junction gate on `roadKey` at `atM` (a block end), or null at a plain road end. */
function gateAt(graph, roadKey, atM) {
    const stop = graph.roads.get(roadKey).stops.find((s) => s.type === 'gate' && Math.abs(s.atM - atM) < 0.5);
    return stop?.gate ?? null;
}

/** How far from a block end (the node's centre) a driveway must keep, for a direction arriving at (`arriving`) or leaving it. */
function endClearM(gate, arriving) {
    if (!gate) return ROAD_END_CLEAR_M;
    const setbackM = gate.centreDistanceM - gate.stopLineDistanceM;
    if (gate.node.control === 'roundabout') return setbackM + ROUNDABOUT_CLEAR_M;
    if (!arriving || !gate.approach) return setbackM + STOP_LINE_CLEAR_M;
    const pocketM = Math.max(0, ...['left', 'right'].map((side) => gate.approach.turnLanes?.[side]?.lengthM ?? 0));
    return setbackM + Math.max(STOP_LINE_CLEAR_M, pocketM ? pocketM + TURN_LANE_TAPER_M + POCKET_MARGIN_M : 0);
}

/** Merge, peel-off and slip-road points along a direction's pieces, in that direction's own along-block distance. */
function joinPointsAlong(engine, pieces) {
    const points = [];
    let offsetM = 0;
    for (const piece of pieces) {
        const atPoints = [
            ...(engine.divergesFrom.get(piece.roadKey) ?? []).map((j) => j.fromAtM),
            ...(engine.mergesInto.get(piece.roadKey) ?? []).map((j) => j.toAtM),
        ];
        for (const atM of atPoints) if (atM >= piece.fromM && atM <= piece.toM) points.push(offsetM + atM - piece.fromM);
        offsetM += piece.toM - piece.fromM;
    }
    return points;
}

/** Free stretches of [0, lengthM] once `zones` ([from, to] pairs) are taken out. */
function freeStretches(lengthM, zones) {
    const sorted = zones.map(([a, b]) => [Math.max(0, a), Math.min(lengthM, b)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
    const free = [];
    let at = 0;
    for (const [a, b] of sorted) {
        if (a > at) free.push([at, a]);
        at = Math.max(at, b);
    }
    if (at < lengthM) free.push([at, lengthM]);
    return free;
}

/** `n` points spread evenly over the free stretches (by length), at least MIN_SPACING_M apart. */
function spread(stretches, n) {
    const totalM = stretches.reduce((s, [a, b]) => s + (b - a), 0);
    const count = Math.min(n, Math.floor(totalM / MIN_SPACING_M));
    const points = [];
    for (let i = 0; i < count; i += 1) {
        let left = ((i + 0.5) / count) * totalM;
        for (const [a, b] of stretches) {
            if (left <= b - a) {
                points.push(a + left);
                break;
            }
            left -= b - a;
        }
    }
    return { points, totalM };
}

/** A road's median width, as written on the arterial or connector it belongs to. */
function medianOf(layout, roadId) {
    const road = layout.arterials.find((a) => a.id === roadId) ?? layout.connectors.find((c) => c.id === roadId);
    return road?.medianWidthM ?? 0;
}

/**
 * @param engine   the constructed SimulationEngine the graph was built from
 * @param graph    routing/graph.js's graph
 * @param blocks   routing/blocks.js's resolved blocks
 * @param routing  the layout's parsed `routing`
 * @param options  `{ countForTier }` - override the driveways-per-side rule (Step 7's fixed-count sensitivity run)
 * @returns `{ driveways, dirs, handOffs }`: every driveway; per block direction its usable driveways, stretch and weight
 */
export function buildDriveways(engine, graph, blocks, routing, { countForTier = drivewaysForTier } = {}) {
    const { layout } = engine;
    const crossable = new Set(routing.crossableMedianRoads);
    const driveways = [];
    const dirs = new Map();

    for (const block of blocks) {
        if (!block.dirs.length) continue;
        const [d0, d1] = block.dirs;
        const L = d0.lengthM;
        const twoWay = Boolean(d1);
        const roadIds = [...new Set(block.dirs.flatMap((d) => d.pieces.map((p) => graph.roads.get(p.roadKey).roadId)))];
        const median = twoWay && roadIds.some((id) => medianOf(layout, id) > 0 && !crossable.has(id));

        // Exclusion zones, in d0's along-block distance (d1's distance u maps to L - u).
        const startOf = (d) => gateAt(graph, d.pieces[0].roadKey, d.pieces[0].fromM);
        const endOf = (d) => gateAt(graph, d.pieces.at(-1).roadKey, d.pieces.at(-1).toM);
        let clearStart = endClearM(startOf(d0), false);
        let clearEnd = endClearM(endOf(d0), true);
        if (d1) {
            clearStart = Math.max(clearStart, endClearM(endOf(d1), true));
            clearEnd = Math.max(clearEnd, endClearM(startOf(d1), false));
        }
        const zones = [[0, clearStart], [L - clearEnd, L]];
        for (const u of joinPointsAlong(engine, d0.pieces)) zones.push([u - JOIN_CLEAR_M, u + JOIN_CLEAR_M]);
        if (d1) for (const u of joinPointsAlong(engine, d1.pieces)) zones.push([L - u - JOIN_CLEAR_M, L - u + JOIN_CLEAR_M]);
        const stretches = freeStretches(L, zones);

        const n = countForTier(block.tier);
        const blockDriveways = [];
        for (const side of ['A', 'B']) {
            const { points, totalM } = spread(stretches, n);
            block.usableM = totalM;
            points.forEach((u, i) => {
                const at = pointAlong(d0.pieces, u);
                const road = graph.roads.get(at.roadKey);
                const { point, heading } = roadPointAt(road.road, at.atM);
                // Side A is d0's left (kerb side, left-hand traffic): left of heading (x, y) is (y, -x) with y pointing south.
                const sign = side === 'A' ? 1 : -1;
                const halfWidthM = (road.road.roadWidthM ?? road.road.lanes * road.road.laneWidthM) / 2;
                const outward = { x: sign * heading.y, y: -sign * heading.x };
                blockDriveways.push({
                    id: `${block.id}-${side}${i + 1}`,
                    blockId: block.id,
                    side,
                    alongM: u,
                    x: point.x + outward.x * halfWidthM,
                    y: point.y + outward.y * halfWidthM,
                    headingDeg: (Math.atan2(outward.x, -outward.y) * 180) / Math.PI,
                });
            });
        }
        driveways.push(...blockDriveways);

        for (const [k, d] of block.dirs.entries()) {
            // d0's kerb is side A; d1 runs the other way, so its kerb is side B.
            const kerb = k === 0 ? 'A' : 'B';
            const reach = blockDriveways
                .filter((w) => w.side === kerb || !twoWay || !median)
                .map((w) => {
                    const alongM = k === 0 ? w.alongM : L - w.alongM;
                    return { drivewayId: w.id, ...pointAlong(d.pieces, alongM), alongM, side: w.side === kerb ? 'left' : 'right', crossesOncoming: twoWay && w.side !== kerb };
                });
            dirs.set(d.id, { id: d.id, blockId: block.id, reach, usableM: block.usableM, weight: 0 });
        }

        // The block's weight goes to its directions in proportion to the driveways each can use (50/50 on a plain two-way street).
        const total = block.dirs.reduce((s, d) => s + dirs.get(d.id).reach.length, 0);
        for (const d of block.dirs) dirs.get(d.id).weight = total ? (block.weight * dirs.get(d.id).reach.length) / total : 0;
    }

    // Directions with nowhere to pull off hand their weight on along their road.
    const handOffs = [];
    const startOn = (dir) => blocks.flatMap((b) => b.dirs).find((d) => d.id === dir.id).pieces;
    for (const dir of dirs.values()) {
        if (dir.reach.length || !(dir.weight > 0)) continue;
        const pieces = startOn(dir);
        const last = pieces.at(-1);
        const first = pieces[0];
        const candidates = [...dirs.values()].filter((other) => other !== dir && other.reach.length);
        const downstream = candidates
            .map((other) => ({ other, p: startOn(other)[0] }))
            .filter(({ p }) => p.roadKey === last.roadKey && p.fromM >= last.toM - 0.5)
            .sort((a, b) => a.p.fromM - b.p.fromM)[0];
        const upstream = candidates
            .map((other) => ({ other, p: startOn(other).at(-1) }))
            .filter(({ p }) => p.roadKey === first.roadKey && p.toM <= first.fromM + 0.5)
            .sort((a, b) => b.p.toM - a.p.toM)[0];
        const target = (downstream ?? upstream)?.other;
        handOffs.push({ from: dir.id, to: target?.id ?? null, weight: dir.weight, way: downstream ? 'downstream' : upstream ? 'upstream' : 'none' });
        if (target) target.weight += dir.weight;
        dir.weight = 0;
    }

    return { driveways, dirs, handOffs };
}
