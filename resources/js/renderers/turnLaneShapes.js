/**
 * turnLaneShapes.js - the road surface of every turn lane (corridor.js's
 * `turnLanes`), shared by the 2D map and the 3D view: a lane-wide strip
 * `lengthM` long up to the stop line, with a taper back into the road ahead
 * of it. World-space shapes (sim metres, y south).
 */
import { TURN_LANE_SIDES, TURN_LANE_TAPER_M } from '../sim/corridor.js';

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
    eachTurnLane(layout, ({ approach, node, side, turnLane, at }) => {
        const halfWidthM = approach.laneWidthM / 2;
        // Towards the kerb for a kerb-side lane, towards the centreline for a median-side one.
        const outward = side === 'left' ? 1 : -1;
        const nearM = turnLane.centreOffsetM - outward * halfWidthM;
        const farM = turnLane.centreOffsetM + outward * halfWidthM;
        const endM = turnLane.lengthM;
        const taperEndM = endM + TURN_LANE_TAPER_M;
        // A lane that leaves as a slip road stops where the slip road peels off - the last stretch to the stop line isn't there.
        const startM = side === 'left' && approach.slip ? approach.slip.backM : 0;
        surfaces.push([at(startM, nearM), at(startM, farM), at(endM, farM), at(taperEndM, nearM)]);
        edges.push([at(startM, farM), at(endM, farM)]);
        // Pocket-to-through-lane boundary (the road's solid edge line sits just inside it) and the taper: dashed like any lane divider.
        const innerM = nearM - outward * 0.25;
        const taper = [at(endM, farM), at(taperEndM, nearM)];
        dividers.push([at(startM, innerM), at(endM, innerM)], taper);
        taperEdges.push(taper);
        if (side === 'left' && turnLane.laneUse.includes('left') && !approach.slip) addLeftTurnCorner(node, approach, at(0, farM), surfaces, edges);
    });
    // A joined road's lane taper (corridor.js's `tapers`) - the same wedge, standing alone.
    for (const [a, b, c] of layout.tapers ?? []) {
        surfaces.push([a, b, c, c]);
        edges.push([b, c], [c, a]);
    }
    // `edges` stays the 2D map's full outline; the 3D view draws `edges` minus `taperEdges`, plus the dashed `dividers`.
    return { surfaces, edges: [...edges, ...taperEdges], solidEdges: edges, dividers };
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
 * kerb lines cross. `corner` is the turn lane's outer corner at its stop line.
 */
function addLeftTurnCorner(node, approach, corner, surfaces, edges) {
    const h = approach.heading;
    // Left-hand traffic: a left turn leaves along the approach's left normal, and that road's kerb is back towards where it came from.
    const exit = { x: h.y, y: -h.x };
    const back = { x: -h.x, y: -h.y };
    let exitRoadWidthM;
    let boxHalfM;
    if (approach.kind === 'arterial') {
        const split = node.crossSplit;
        const alongAxis = exit.x * node.crossAxis.x + exit.y * node.crossAxis.y > 0;
        exitRoadWidthM = split ? (alongAxis ? split.end : split.start).connector.roadWidthM : node.crossRoadWidthM;
        boxHalfM = node.arterialRoadWidthM / 2;
    } else {
        exitRoadWidthM = node.arterialRoadWidthM;
        boxHalfM = node.crossRoadWidthM / 2;
    }
    // The exit road's kerb where it leaves the junction box.
    const kerb = {
        x: node.point.x + back.x * (exitRoadWidthM / 2) + exit.x * boxHalfM,
        y: node.point.y + back.y * (exitRoadWidthM / 2) + exit.y * boxHalfM,
    };
    // Where the turn lane's outer edge, carried on, would cross the exit road's kerb - the square corner being rounded off.
    const square = intersect(corner, h, kerb, exit);
    // Where the stop line meets the box edge - the inside of the corner.
    const inner = intersect(corner, exit, kerb, h);
    if (!square || !inner) return;
    // Only where the turn lane really does stick out past the box edge, on the far side of the exit road's kerb.
    const beyondBoxM = (corner.x - inner.x) * exit.x + (corner.y - inner.y) * exit.y;
    const radiusM = (corner.x - square.x) * back.x + (corner.y - square.y) * back.y;
    if (beyondBoxM <= 0.05 || radiusM <= 0.05) return;
    const end = { x: square.x + exit.x * radiusM, y: square.y + exit.y * radiusM };

    const curve = Array.from({ length: CORNER_CURVE_STEPS + 1 }, (_, i) => {
        const t = i / CORNER_CURVE_STEPS;
        const a = (1 - t) * (1 - t);
        const b = 2 * (1 - t) * t;
        const c = t * t;
        return { x: a * corner.x + b * square.x + c * end.x, y: a * corner.y + b * square.y + c * end.y };
    });
    // Fanned from the exit road's kerb at the box edge: the stop line's bit of box edge, then the curve down to where it meets that kerb.
    surfaces.push([kerb, inner, corner, corner]);
    for (let i = 0; i < CORNER_CURVE_STEPS; i += 1) {
        surfaces.push([kerb, curve[i], curve[i + 1], curve[i + 1]]);
        edges.push([curve[i], curve[i + 1]]);
    }
}

/** How far back from the junction centre `approach`'s median-side turn lane (and its taper) reaches, or 0 - where a median island has to stop. */
export function medianTurnLaneReachM(approach) {
    const turnLane = approach?.turnLanes?.right;
    return turnLane ? approach.setbackM + turnLane.lengthM + TURN_LANE_TAPER_M : 0;
}
