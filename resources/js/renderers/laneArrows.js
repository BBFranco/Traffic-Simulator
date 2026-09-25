/**
 * laneArrows.js - painted lane-use arrows on every approach that carries
 * traffic (the arterial and any real cross street), shared by the 2D map and
 * the 3D view so both show exactly what each approach's `laneUse` allows (the
 * rules engine.js's turn planning enforces).
 *
 * Returns world-space shapes (sim metres, y south): shaft/branch segments and
 * arrowhead triangles. Each lane gets one arrow per distance in
 * ARROW_DISTANCES_M upstream of the stop line; a turn branch bends towards the
 * kerb for left and towards the median for right. A turn lane (corridor.js's
 * `turnLanes`) gets whichever of those fit inside it.
 */
import { TURN_LANE_SIDES, laneMovesOf } from '../sim/corridor.js';

const ARROW_DISTANCES_M = [8, 45];
/** How far an arrow reaches upstream of its own position, and downstream (its head) - see pushArrow(). */
const ARROW_TAIL_M = 4;
const ARROW_HEAD_M = 2.2;

/** Approaches with lane use to paint - a cross-street stub (no connector) has none. */
function markedApproaches(layout) {
    const result = [];
    for (const arterial of layout.arterials) {
        for (const node of arterial.intersections) {
            for (const approach of node.approaches) {
                if (approach.laneUse) result.push(approach);
            }
        }
    }
    return result;
}

/** Arrow positions along a turn lane: the usual ones that fit inside it, or one squeezed in near the stop line. */
function turnLaneArrowDistances(lengthM) {
    const fitting = ARROW_DISTANCES_M.filter((backM) => backM + ARROW_TAIL_M <= lengthM);
    return fitting.length ? fitting : [Math.max(ARROW_HEAD_M + 0.5, lengthM - ARROW_TAIL_M - 0.5)];
}

/** Every lane of `approach` with the distances its arrows sit at: lane indices, then 'left'/'right' for its turn lanes. */
function arrowLanes(approach) {
    const lanes = approach.laneUse.map((_, lane) => ({ lane, distances: ARROW_DISTANCES_M }));
    for (const side of TURN_LANE_SIDES) {
        const turnLane = approach.turnLanes?.[side];
        if (turnLane) lanes.push({ lane: side, distances: turnLaneArrowDistances(turnLane.lengthM) });
    }
    return lanes;
}

/** Where one lane's arrow sits `backM` upstream of the stop line, plus the (u along travel, v towards the kerb) frame to draw it in. */
function arrowFrame(approach, lane, backM) {
    const h = approach.heading;
    const left = { x: h.y, y: -h.x };
    const offsetM = typeof lane === 'string' ? approach.turnLanes[lane].centreOffsetM : approach.laneCentreOffsets[lane];
    const base = {
        x: approach.stopCentre.x + left.x * offsetM - h.x * backM,
        y: approach.stopCentre.y + left.y * offsetM - h.y * backM,
    };
    return { base, at: (u, v) => ({ x: base.x + h.x * u + left.x * v, y: base.y + h.y * u + left.y * v }) };
}

/** Pushes one arrow for `moves` into `lines`/`heads`. */
function pushArrow(lines, heads, at, moves) {
    const hasStraight = moves.includes('straight');
    lines.push([at(-ARROW_TAIL_M, 0), at(hasStraight ? 1.2 : -1.2, 0)]);
    if (hasStraight) heads.push([at(ARROW_HEAD_M, 0), at(1.2, 0.42), at(1.2, -0.42)]);

    for (const [move, side] of [
        ['left', 1],
        ['right', -1],
    ]) {
        if (!moves.includes(move)) continue;
        lines.push([at(-1.2, 0), at(-1.2, 0.75 * side)]);
        heads.push([at(-1.2, 1.45 * side), at(-0.78, 0.75 * side), at(-1.62, 0.75 * side)]);
    }
}

/** `filter(approach, lane)` limits the arrows drawn - the editor uses it to paint edited lanes in their own colour. */
export function laneArrowShapes(layout, filter = null) {
    const lines = [];
    const heads = [];

    for (const approach of markedApproaches(layout)) {
        for (const { lane, distances } of arrowLanes(approach)) {
            if (filter && !filter(approach, lane)) continue;
            for (const backM of distances) pushArrow(lines, heads, arrowFrame(approach, lane, backM).at, laneMovesOf(approach, lane));
        }
    }

    return { lines, heads };
}

/**
 * Click targets for the lane-arrow editor: every painted arrow's centre, with
 * the approach and lane (index, or 'left'/'right' for a turn lane) it belongs
 * to. A single-lane approach's own lane always allows everything, so only its
 * turn lanes are targets there.
 */
export function laneArrowTargets(layout) {
    const targets = [];
    for (const approach of markedApproaches(layout)) {
        for (const { lane, distances } of arrowLanes(approach)) {
            if (typeof lane === 'number' && approach.lanes < 2) continue;
            for (const backM of distances) targets.push({ approach, lane, point: arrowFrame(approach, lane, backM).at(-1, 0) });
        }
    }
    return targets;
}
