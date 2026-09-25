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
    eachTurnLane(layout, ({ approach, side, turnLane, at }) => {
        const halfWidthM = approach.laneWidthM / 2;
        // Towards the kerb for a kerb-side lane, towards the centreline for a median-side one.
        const outward = side === 'left' ? 1 : -1;
        const nearM = turnLane.centreOffsetM - outward * halfWidthM;
        const farM = turnLane.centreOffsetM + outward * halfWidthM;
        const endM = turnLane.lengthM;
        const taperEndM = endM + TURN_LANE_TAPER_M;
        surfaces.push([at(0, nearM), at(0, farM), at(endM, farM), at(taperEndM, nearM)]);
        edges.push([at(0, farM), at(endM, farM)], [at(endM, farM), at(taperEndM, nearM)]);
    });
    return { surfaces, edges };
}

/** How far back from the junction centre `approach`'s median-side turn lane (and its taper) reaches, or 0 - where a median island has to stop. */
export function medianTurnLaneReachM(approach) {
    const turnLane = approach?.turnLanes?.right;
    return turnLane ? approach.setbackM + turnLane.lengthM + TURN_LANE_TAPER_M : 0;
}
