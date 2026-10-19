/**
 * turnLaneShapes.js - the road surface of every turn lane (corridor.js's
 * `turnLanes`), shared by the 2D map and the 3D view: a lane-wide strip
 * `lengthM` long up to the stop line, with a taper back into the road ahead
 * of it. World-space shapes (sim metres, y south).
 */
import { TURN_LANE_SIDES, TURN_LANE_TAPER_M, laneShiftAt } from '../sim/corridor.js';

/** Every approach's turn lanes, each with a frame `at(backM, offsetM)`: `backM` upstream of the stop line, `offsetM` along the approach's left normal. */
export function eachTurnLane(layout, callback) {
    for (const arterial of layout.arterials) {
        for (const node of arterial.intersections) {
            for (const approach of node.approaches) {
                const h = approach.heading;
                const left = { x: h.y, y: -h.x };
                const at = (backM, offsetM) => ({
                    x: approach.stopCentre.x - h.x * backM + left.x * offsetM,
                    y: approach.stopCentre.y - h.y * backM + left.y * offsetM,
                });
                // Fed by a road joined on right before the junction: that road already has the turn lane's lane (corridor.js's `fedByJoin`).
                if (approach.fedByJoin) continue;
                for (const side of TURN_LANE_SIDES) {
                    const turnLane = approach.turnLanes?.[side];
                    if (turnLane) callback({ approach, node, side, turnLane, at });
                }
            }
        }
    }
}

/**
 * `surfaces`: one quad per turn lane (full width to the stop line, tapering to
 * nothing at the road edge `TURN_LANE_TAPER_M` further back). `edges`: its
 * outer edge line and taper line, as two-point segments. The edge it shares
 * with the road is the road's own edge (or median kerb) line.
 */
export function turnLaneShapes(layout) {
    const surfaces = [];
    const edges = [];
    const dividers = [];
    const taperEdges = [];
    const masks = [];
    const dashMasks = [];
    eachTurnLane(layout, ({ approach, node, side, turnLane, at }) => {
        const halfWidthM = approach.laneWidthM / 2;
        // Towards the kerb for a kerb-side lane, towards the centreline for a median-side one.
        const outward = side === 'left' ? 1 : -1;
        const nearM = turnLane.centreOffsetM - outward * halfWidthM;
        const farM = turnLane.centreOffsetM + outward * halfWidthM;
        const endM = turnLane.lengthM;
        const taperEndM = endM + TURN_LANE_TAPER_M;
        // A lane that leaves as a slip road stops where the slip road peels off - the last stretch to the stop line isn't there
        // (unless it also goes straight on - then only its left turns leave by the slip road).
        const startM = side === 'left' && approach.slip && !turnLane.laneUse.includes('straight') ? approach.slip.backM : 0;
        const shapes = { surfaces, edges, dividers, taperEdges, masks, dashMasks };
        if (side === 'right' && approach.laneShift) addLaneShift(approach, at, shapes);
        if (side === 'left' && turnLane.exitM > 0) addRunOut(approach, turnLane, at, shapes);
        surfaces.push([at(startM, nearM), at(startM, farM), at(endM, farM), at(taperEndM, nearM)]);
        edges.push([at(startM, farM), at(endM, farM)]);
        // Pocket-to-through-lane boundary (the road's solid edge line sits just inside it) and the taper: dashed like any lane divider.
        const innerM = nearM - outward * 0.25;
        const taper = [at(endM, farM), at(taperEndM, nearM)];
        dividers.push([at(startM, innerM), at(endM, innerM)], taper);
        taperEdges.push(taper);
        if (side === 'left' && turnLane.laneUse.includes('left') && !approach.slip) {
            const carriedOn = addLeftTurnCorner(node, approach, at(0, farM), at(0, nearM), surfaces, edges);
            // Paved on past a set-back stop line: the road's edge line along there is painted out, with no dashes in its place.
            // (On the lane edge for the 2D map, just inside it for the 3D view.)
            if (carriedOn) masks.push([at(0, nearM), at(-carriedOn, nearM)], [at(0, innerM), at(-carriedOn, innerM)]);
        }
    });
    // A joined road's lane taper (corridor.js's `tapers`) - the same wedge, standing alone.
    for (const [a, b, c] of layout.tapers ?? []) {
        surfaces.push([a, b, c, c]);
        edges.push([b, c], [c, a]);
    }
    // `edges` stays the 2D map's full outline; the 3D view draws `edges` minus `taperEdges`, plus the dashed `dividers`. `masks`: edge line
    // to paint out only; `dashMasks`: a road's own dashed lane line to paint out (the 3D view has to lay those over the road's dashes).
    return { surfaces, edges: [...edges, ...taperEdges], solidEdges: edges, dividers, masks, dashMasks };
}

/** Points `fromM` to `toM` (backM, either way round), every `stepM` or so, ends included. */
function sampleBacks(fromM, toM, stepM = 1.5) {
    const n = Math.max(1, Math.ceil(Math.abs(toM - fromM) / stepM));
    return Array.from({ length: n + 1 }, (_, i) => fromM + ((toM - fromM) * i) / n);
}

/** Consecutive pairs of `points` as two-point segments (what every line list here holds). */
function segmentsOf(points) {
    return points.slice(1).map((p, i) => [points[i], p]);
}

/**
 * A double right turn lane's lane shift (corridor.js's laneShiftAt()): the approach's half of the road widens on the
 * kerb side by the shift, its lanes easing over ahead of the turn lane and back across the junction box. Drawn as the
 * widening, the new kerb line, and the through lanes' lines moved over with them - the old kerb line and the road's own
 * lane line through the easing are painted out. (The second turn lane itself is the road the through lanes moved off.)
 */
function addLaneShift(approach, at, { surfaces, edges, dividers, masks, dashMasks }) {
    const shift = approach.laneShift;
    const halfM = approach.roadWidthM / 2;
    const laneM = approach.laneWidthM;
    const shiftAt = (backM) => laneShiftAt(shift, backM);
    // The widened road, on to the far edge of the junction box (the box covers the easing back).
    const backs = sampleBacks(shift.rampFromBackM, -shift.endPastStopM);
    for (let i = 1; i < backs.length; i += 1) {
        const [b0, b1] = [backs[i - 1], backs[i]];
        surfaces.push([at(b0, halfM), at(b0, halfM + shiftAt(b0)), at(b1, halfM + shiftAt(b1)), at(b1, halfM)]);
    }
    // The new kerb line, to the box edge.
    const toBox = sampleBacks(shift.rampFromBackM, -shift.holdPastStopM);
    edges.push(...segmentsOf(toBox.map((b) => at(b, halfM + shiftAt(b)))));
    // The old kerb line, from where the new one has moved clear of it (on the line for the 2D map, just inside it for the 3D view).
    const clearM = shift.rampFromBackM - 0.2 * (shift.rampFromBackM - shift.fullFromBackM);
    masks.push([at(clearM, halfM), at(-shift.holdPastStopM, halfM)], [at(clearM, halfM - 0.25), at(-shift.holdPastStopM, halfM - 0.25)]);
    // The lane lines moved over: the kerb lane's inner line onto the old kerb line, and the inner lane's onto the old lane line -
    // whose line through the easing goes (past it, it's the line between the inner through lane and the second turn lane).
    const easing = sampleBacks(shift.rampFromBackM, shift.fullFromBackM);
    for (let k = 1; k <= approach.lanes; k += 1) {
        const offsetM = halfM - k * laneM;
        dividers.push(...segmentsOf(easing.map((b) => at(b, offsetM + shiftAt(b)))));
    }
    dividers.push([at(shift.fullFromBackM, halfM - laneM + shift.shiftM), at(-shift.holdPastStopM, halfM - laneM + shift.shiftM)]);
    for (let k = 1; k < approach.lanes; k += 1) dashMasks.push([at(shift.rampFromBackM, halfM - k * laneM), at(shift.fullFromBackM, halfM - k * laneM)]);
}

/**
 * A kerb turn lane that goes straight on and carries on past the junction for `exitM` (a run-out) before merging back:
 * paved across the junction beside the road (eased back with any lane shift), then a lane-wide strip past the box with
 * a taper back into the road. `at` is the approach's frame, so past the junction is negative backM.
 */
function addRunOut(approach, turnLane, at, { surfaces, edges, dividers, taperEdges, masks }) {
    const halfM = approach.roadWidthM / 2;
    const laneM = approach.laneWidthM;
    const shiftAt = (backM) => laneShiftAt(approach.laneShift, backM);
    const farEdgeM = approach.setbackM + approach.boxEdgeM;
    const nearEdgeM = approach.setbackM - approach.boxEdgeM;
    // Across the junction, from the stop line to the far edge of the box: the lane carried on, beside the road.
    const across = sampleBacks(0, -farEdgeM);
    for (let i = 1; i < across.length; i += 1) {
        const [b0, b1] = [across[i - 1], across[i]];
        surfaces.push([at(b0, halfM + shiftAt(b0)), at(b0, halfM + laneM + shiftAt(b0)), at(b1, halfM + laneM + shiftAt(b1)), at(b1, halfM + shiftAt(b1))]);
    }
    // Up to the box: its outer kerb, and the line between it and the kerb lane (the road's kerb line moved over, painted out by addLaneShift() or here).
    const toBox = sampleBacks(0, -nearEdgeM);
    edges.push(...segmentsOf(toBox.map((b) => at(b, halfM + laneM + shiftAt(b)))));
    dividers.push(...segmentsOf(toBox.map((b) => at(b, halfM + shiftAt(b)))));
    if (!approach.laneShift) masks.push([at(0, halfM), at(-nearEdgeM, halfM)], [at(0, halfM - 0.25), at(-nearEdgeM, halfM - 0.25)]);
    // ...and on across the box, which at a skewed crossing doesn't cover all of it.
    masks.push([at(-nearEdgeM, halfM), at(-farEdgeM, halfM)], [at(-nearEdgeM, halfM - 0.25), at(-farEdgeM, halfM - 0.25)]);
    // Past the box: the run-out and its taper back into the road.
    const endM = -farEdgeM - turnLane.exitM;
    const taperEndM = endM - TURN_LANE_TAPER_M;
    surfaces.push([at(-farEdgeM, halfM), at(-farEdgeM, halfM + laneM), at(endM, halfM + laneM), at(taperEndM, halfM)]);
    edges.push([at(-farEdgeM, halfM + laneM), at(endM, halfM + laneM)]);
    const taper = [at(endM, halfM + laneM), at(taperEndM, halfM)];
    dividers.push([at(-farEdgeM, halfM - 0.25), at(endM, halfM - 0.25)], taper);
    taperEdges.push(taper);
    masks.push([at(-farEdgeM, halfM), at(endM, halfM)]);
}

/**
 * Cuts a two-point `segment` into dash pieces that continue the dashes of the straight road it runs along
 * (those start at the road's `from` and repeat every `dashM + gapM`, first dash at `firstM`), so a turn
 * lane's divider lines up with the through lanes' stripes. A segment on no straight road - a taper - is
 * dashed from its own start instead. `roads` is the renderer's eachRoad() list.
 */
export function alignedDashes(segment, roads, dashM, gapM, firstM) {
    const [a, b] = segment;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return [];
    const along = (road) => {
        // The road's centreline (a bend is a polyline), with the distance along it at each vertex - the same measure its dashes are cut by.
        const points = road.curvePoints ?? [road.from, road.to];
        let travelled = 0;
        for (let i = 1; i < points.length; i += 1) {
            const rx = points[i].x - points[i - 1].x;
            const ry = points[i].y - points[i - 1].y;
            const segmentLength = Math.hypot(rx, ry);
            if (segmentLength < 1e-6) continue;
            const hx = rx / segmentLength;
            const hy = ry / segmentLength;
            const relX = a.x - points[i - 1].x;
            const relY = a.y - points[i - 1].y;
            const t = relX * hx + relY * hy;
            const lateral = Math.abs(relX * hy - relY * hx);
            const parallel = Math.abs(dx * hy - dy * hx) <= 0.05 * length;
            if (parallel && t >= -1 && t <= segmentLength + 1 && lateral <= road.widthM / 2 + 4) {
                const sa = travelled + t;
                return { hx, hy, sa, sb: sa + dx * hx + dy * hy };
            }
            travelled += segmentLength;
        }
        return null;
    };
    let frame = null;
    for (const road of roads) {
        frame = along(road);
        if (frame) break;
    }
    if (!frame) frame = { hx: dx / length, hy: dy / length, sa: 0, sb: length };
    const period = dashM + gapM;
    const lo = Math.min(frame.sa, frame.sb);
    const hi = Math.max(frame.sa, frame.sb);
    const pointAt = (s) => ({ x: a.x + frame.hx * (s - frame.sa), y: a.y + frame.hy * (s - frame.sa) });
    const pieces = [];
    for (let start = firstM + Math.floor((lo - firstM) / period) * period; start < hi; start += period) {
        const s0 = Math.max(start, lo);
        const s1 = Math.min(start + dashM, hi);
        if (s1 - s0 > 1e-6) pieces.push([pointAt(s0), pointAt(s1)]);
    }
    return pieces;
}

/** Points along the drawn corner curve - enough that it reads as a curve at any zoom the map allows. */
const CORNER_CURVE_STEPS = 12;

/** Where the line through `p` along `u` meets the line through `q` along `v`, or null if they're parallel. */
function intersect(p, u, q, v) {
    const denom = u.x * v.y - u.y * v.x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / denom;
    return { x: p.x + u.x * t, y: p.y + u.y * t };
}

/**
 * Drawn only: a kerb-side left-turn lane widens the road past the junction box's
 * edge, so the corner between it and the road the turn goes into would be bare
 * ground that turning cars cross. This paves it with a kerb that follows the
 * turn: carrying on from the turn lane's outer edge at its stop line, it bends
 * round the way the cars do and meets the other road's kerb as far down it as
 * it started across - a rounded version of the square corner where those two
 * kerb lines cross. `corner` is the turn lane's outer corner at its stop line,
 * `laneInner` its inner one. A stop line set back from the box (a skewed
 * crossing) also gets the lane paved on from it up to the other road's kerb -
 * returns how far on (metres past the stop line), else 0.
 */
function addLeftTurnCorner(node, approach, corner, laneInner, surfaces, edges) {
    const h = approach.heading;
    // Left-hand traffic: a left turn leaves towards the approach's left normal, along the other road's axis (skewed at a skewed junction).
    const left = { x: h.y, y: -h.x };
    const otherAxis = approach.kind === 'arterial' ? node.crossAxis : node.arterialHeading;
    const sign = otherAxis.x * left.x + otherAxis.y * left.y >= 0 ? 1 : -1;
    const exit = { x: otherAxis.x * sign, y: otherAxis.y * sign };
    // The exit road's side facing back towards where the approach came from - its kerb the turn ends against.
    const exitBack = { x: -exit.y, y: exit.x };
    if (exitBack.x * h.x + exitBack.y * h.y > 0) [exitBack.x, exitBack.y] = [-exitBack.x, -exitBack.y];
    let exitRoadWidthM;
    let boxHalfM;
    if (approach.kind === 'arterial') {
        const split = node.crossSplit;
        exitRoadWidthM = split ? (sign > 0 ? split.end : split.start).connector.roadWidthM : node.crossRoadWidthM;
        boxHalfM = node.arterialRoadWidthM / 2;
    } else {
        exitRoadWidthM = node.arterialRoadWidthM;
        boxHalfM = node.crossRoadWidthM / 2;
    }
    // Turning into a run-out (a kerb lane carried on past the junction by the road travelling the way the turn leaves): its outer kerb, a lane further out.
    const runOutBy = node.approaches.find((a) => a.turnLanes?.left?.exitM > 0 && a.heading.x * exit.x + a.heading.y * exit.y > 0.9);
    const exitKerbM = exitRoadWidthM / 2 + (runOutBy ? runOutBy.laneWidthM : 0);
    // The exit road's kerb where it leaves the junction box: where it crosses the approach road's left kerb.
    const kerb = intersect(
        { x: node.point.x + exitBack.x * exitKerbM, y: node.point.y + exitBack.y * exitKerbM },
        exit,
        { x: node.point.x + left.x * boxHalfM, y: node.point.y + left.y * boxHalfM },
        h,
    );
    if (!kerb) return 0;
    // Where the turn lane's outer edge, carried on, would cross the exit road's kerb - the corner being rounded off.
    const square = intersect(corner, h, kerb, exit);
    // Where the stop line meets the box edge - the inside of the corner.
    const inner = intersect(corner, left, kerb, h);
    if (!square || !inner) return 0;
    // Only where the turn lane really does stick out past the box - beside it, or short of it behind a set-back stop line.
    const beyondBoxM = (corner.x - inner.x) * left.x + (corner.y - inner.y) * left.y;
    const radiusM = (square.x - corner.x) * h.x + (square.y - corner.y) * h.y;
    if (radiusM <= 0.05) return 0;
    const setBack = !pointInPolygon(corner, junctionBoxPolygon(node), 0.05);
    if (beyondBoxM <= 0.05 && !setBack) return 0;
    // A run-out's kerb only goes so far: the curve meets it a couple of metres short of its end.
    const runOutLeftM = runOutBy
        ? runOutBy.boxEdgeM + runOutBy.turnLanes.left.exitM - 2 - ((square.x - node.point.x) * exit.x + (square.y - node.point.y) * exit.y)
        : Infinity;
    const end = { x: square.x + exit.x * Math.max(0.5, Math.min(radiusM, runOutLeftM)), y: square.y + exit.y * Math.max(0.5, Math.min(radiusM, runOutLeftM)) };
    // The lane carried on from its stop line to the other road's kerb, under the curve.
    const laneKerb = setBack ? intersect(laneInner, h, kerb, exit) : null;

    const curve = Array.from({ length: CORNER_CURVE_STEPS + 1 }, (_, i) => {
        const t = i / CORNER_CURVE_STEPS;
        const a = (1 - t) * (1 - t);
        const b = 2 * (1 - t) * t;
        const c = t * t;
        return { x: a * corner.x + b * square.x + c * end.x, y: a * corner.y + b * square.y + c * end.y };
    });
    // Fanned from the exit road's kerb at the box edge (or where the lane's inner edge meets it): the stop line's bit of box edge, then the curve down to where it meets that kerb.
    const hub = laneKerb ?? kerb;
    surfaces.push(laneKerb ? [laneKerb, laneInner, corner, corner] : [kerb, inner, corner, corner]);
    for (let i = 0; i < CORNER_CURVE_STEPS; i += 1) {
        surfaces.push([hub, curve[i], curve[i + 1], curve[i + 1]]);
        edges.push([curve[i], curve[i + 1]]);
    }
    return laneKerb ? (laneKerb.x - laneInner.x) * h.x + (laneKerb.y - laneInner.y) * h.y : 0;
}

/** Whether `p` lies inside `polygon` by more than `marginM` (a point on its edge counts as inside). */
function pointInPolygon(p, polygon, marginM) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const a = polygon[i];
        const b = polygon[j];
        const lengthM = Math.hypot(b.x - a.x, b.y - a.y);
        if (lengthM > 1e-9 && Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / lengthM <= marginM) {
            const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (lengthM * lengthM);
            if (t >= 0 && t <= 1) return true;
        }
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

/**
 * A junction box: where the arterial and the cross street overlap - a parallelogram with its sides along both roads,
 * so a skewed crossing is covered kerb to kerb without poking out past either road (a rectangle at a square crossing).
 */
export function junctionBoxPolygon(node) {
    const a = node.arterialHeading;
    const c = node.crossAxis;
    // Floored so a near-parallel cross street can't throw the corners off to infinity.
    const sin = Math.max(0.2, Math.abs(a.x * c.y - a.y * c.x));
    const alongA = node.crossRoadWidthM / 2 / sin;
    const alongC = node.arterialRoadWidthM / 2 / sin;
    const at = (s, t) => ({ x: node.point.x + a.x * alongA * s + c.x * alongC * t, y: node.point.y + a.y * alongA * s + c.y * alongC * t });
    return [at(1, 1), at(1, -1), at(-1, -1), at(-1, 1)];
}

/** How far back from the junction centre `approach`'s median-side turn lane (and its taper) reaches, or 0 - where a median island has to stop. */
export function medianTurnLaneReachM(approach) {
    const turnLane = approach?.turnLanes?.right;
    return turnLane ? approach.setbackM + turnLane.lengthM + TURN_LANE_TAPER_M : 0;
}
