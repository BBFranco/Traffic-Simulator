/**
 * Slip lanes: an approach's left-turn lane that peels off `backM` before its stop line, runs round the corner
 * outside the junction box on its own lane, and merges into the kerb lane of the road it turns onto. Each is a
 * plain connector (id `slip_<node>_<direction>`) joined to the roads it serves (see corridor.js's parseJoins()):
 * a join with `slip: true` where it peels off, one with `toAtM` where its cars give way. The node lists it in
 * `slipLanes`. Drawn from the engine's own geometry, so a changed layout is a regenerate - the Road Editor's
 * slip-lane toggle and scripts/slip-lanes.mjs both go through withSlipLanes().
 */
import { buildLayout, compassDirection, leftNormal } from './corridor.js';
import { SimulationEngine } from './engine.js';
import { lanePoint } from './car.js';

/** Centreline radius of a slip road's corner, m. */
export const CORNER_RADIUS_M = 12;
/** The slip lane runs this far alongside the road it turns onto, then angles in over MERGE_ANGLE_DEG. */
export const RUN_ALONGSIDE_M = 10;
export const MERGE_ANGLE_DEG = 15;
const SLIP_SPEED_KPH = 30;

const add = (p, v, t) => ({ x: p.x + v.x * t, y: p.y + v.y * t });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const round = (v) => Math.round(v * 10) / 10;
const pt = (p) => ({ xM: round(p.x), yM: round(p.y) });

export const isSlipConnectorId = (id) => id.startsWith('slip_');

export function intersect(p, u, q, v) {
    const denom = u.x * v.y - u.y * v.x;
    if (Math.abs(denom) < 1e-9) throw new Error('parallel lines');
    const t = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / denom;
    return add(p, u, t);
}

/** The distance along `road` (lane `lane`) whose point is nearest `target`, searched over [from, to] metres. */
export function distanceOf(road, lane, target, from, to) {
    let best = from;
    let bestD = Infinity;
    for (let d = from; d <= to; d += 0.25) {
        const p = lanePoint(road, lane, d).point;
        const dist = Math.hypot(p.x - target.x, p.y - target.y);
        if (dist < bestD) [best, bestD] = [d, dist];
    }
    return round(best);
}

/** The slip lanes a config has now: `[{ node, direction }]` (direction = compass direction of travel of the approach). */
export function slipLaneSpecs(config) {
    return config.arterials.flatMap((arterial) => (arterial.intersections ?? []).flatMap((node) => (node.slipLanes ?? []).map((slip) => ({ node: node.id, direction: slip.direction }))));
}

/** A copy of `config` without any slip lanes - no slip connectors, their joins, or nodes' `slipLanes`. */
export function withoutSlipLanes(config) {
    const plain = structuredClone(config);
    plain.connectors = plain.connectors.filter((c) => !isSlipConnectorId(c.id));
    plain.joins = (plain.joins ?? []).filter((j) => ![j.from, j.to].some((ref) => isSlipConnectorId(ref.split(':')[0])));
    for (const arterial of plain.arterials) for (const node of arterial.intersections ?? []) delete node.slipLanes;
    return plain;
}

/**
 * A copy of `config` with exactly the slip lanes `specs` (`[{ node, direction }]`), each drawn afresh. Throws, naming
 * the approach, where one can't be: no left turn, no left-only lane, or a left-turn lane shorter than where the slip
 * peels off. `slips` describes what was drawn.
 */
export function withSlipLanes(config, specs) {
    const result = withoutSlipLanes(config);
    if (!specs.length) return { config: result, slips: [] };

    const layout = buildLayout(result);
    const engine = new SimulationEngine(layout);
    const nodeById = new Map(layout.arterials.flatMap((a) => a.intersections.map((n) => [n.id, n])));
    const rawNode = (id) => result.arterials.flatMap((a) => a.intersections).find((n) => n.id === id);

    const slips = specs.map((spec) => {
        const label = `${nodeById.get(spec.node)?.name ?? spec.node} ${spec.direction}`;
        const node = nodeById.get(spec.node);
        if (!node) throw new Error(`No intersection "${spec.node}" for a slip lane.`);
        const approach = node.approaches.find((a) => compassDirection(a.heading) === spec.direction);
        if (!approach) throw new Error(`${label}: no approach runs ${spec.direction} here.`);
        const gate = engine.gatesByApproachId.get(approach.id);
        const left = gate.turnOptions.find((o) => o.movement === 'left');
        if (!left) throw new Error(`${label}: no left turn there for a slip lane.`);

        // The road the slip comes off, and its left-turn lane.
        const fromRoad = gate.carriageway ?? gate.dir;
        const fromKey = gate.carriageway ? gate.carriageway.id : `${gate.connector.id}:${gate.dirKey}`;
        // A left-only lane, or a kerb turn lane that also goes straight on (only its left turners take the slip).
        const leftOnlySlot = gate.slotLaneUse.findIndex((moves) => moves.includes('left') && !moves.includes('straight'));
        const kerbTurnSlot = fromRoad.laneLayout.kerbSlots && gate.slotLaneUse[0]?.includes('left') ? 0 : -1;
        const pocketSlot = leftOnlySlot >= 0 ? leftOnlySlot : kerbTurnSlot;
        if (pocketSlot < 0) throw new Error(`${label}: a slip lane needs a left-only lane, or a kerb turn lane that allows left.`);
        const stopA = lanePoint(fromRoad.road, pocketSlot, gate.stopLineDistanceM);
        const h = stopA.heading;

        // The road it turns onto - past any join that carries it straight on (a stub that widens into the road proper) - its kerb lane, and the line a lane further out where the slip runs.
        let exit = left.carriagewayId
            ? { key: left.carriagewayId, dir: engine.carriagewaysById.get(left.carriagewayId), entryM: left.entryDistanceM }
            : { key: `${left.connectorId}:${left.dirKey}`, dir: engine.connectorDirs.get(left.connectorId)[left.dirKey], entryM: left.entryDistanceM };
        while (engine.joinsFrom.has(exit.key) && exit.entryM > (exit.dir.lengthM ?? engine.connectorsById.get(exit.key.split(':')[0]).routeLengthM) - 1) {
            const join = engine.joinsFrom.get(exit.key);
            exit = { key: join.to.key, dir: join.to.dir, entryM: Math.max(0, exit.entryM - join.from.lengthM) };
        }
        const exitDir = exit.dir;
        const exitKerbLane = exitDir.laneLayout.kerbSlots;
        const refM = exit.entryM + 6; // a little past the junction box, on the road proper
        const atNode = lanePoint(exitDir.road, exitKerbLane, refM);
        const e = atNode.heading;
        const laneW = exitDir.road.laneWidthM;
        const outward = leftNormal(e); // the kerb is on the left in left-hand traffic
        const runLine = add(atNode.point, outward, laneW);

        const corner = intersect(stopA.point, h, runLine, e);
        // Centreline radius R of a corner between lines turning by `theta` has legs R * tan(theta / 2).
        const theta = Math.acos(Math.max(-1, Math.min(1, dot(h, e))));
        const leg = CORNER_RADIUS_M * Math.tan(theta / 2);
        const p0 = add(corner, h, -leg);
        const p1 = add(corner, e, leg);
        const c2 = add(p1, e, RUN_ALONGSIDE_M);
        const alpha = (MERGE_ANGLE_DEG * Math.PI) / 180;
        const inward = { x: -outward.x, y: -outward.y };
        const dir2 = { x: e.x * Math.cos(alpha) + inward.x * Math.sin(alpha), y: e.y * Math.cos(alpha) + inward.y * Math.sin(alpha) };
        const p2 = add(c2, dir2, laneW / Math.sin(alpha));

        const backM = round(dot(sub(stopA.point, p0), h));
        // The slip leaves from the left-turn lane, so that lane has to reach back past where it peels off.
        const pocket = approach.turnLanes?.left;
        if (pocket && pocket.lengthM < backM) {
            throw new Error(`${label}: the slip lane peels off ${backM} m before the stop line, but the left turn lane is only ${pocket.lengthM} m - make it at least ${Math.ceil(backM)} m first.`);
        }
        return {
            spec,
            id: `slip_${spec.node}_${spec.direction}`,
            backM,
            fromKey,
            exitKey: exit.key,
            fromAtM: round(gate.stopLineDistanceM - backM),
            toAtM: distanceOf(exitDir.road, exitKerbLane, p2, exit.entryM, exit.entryM + 120),
            lengthM: round(leg * 2 + RUN_ALONGSIDE_M + laneW / Math.sin(alpha)),
            curve: [p0, corner, p1, c2, p2].map(pt),
        };
    });

    for (const slip of slips) {
        // The curve is anchors at the even indices and controls at the odd ones: P0, corner, P1, run control, P2.
        result.connectors.push({ id: slip.id, mode: 'fixed', name: '', curve: slip.curve, lanes: 1, twoWay: false, turnChance: 0, crossChance: 0, targetSpeedKph: SLIP_SPEED_KPH });
        result.joins.push({ from: slip.fromKey, to: `${slip.id}:fwd`, fromAtM: slip.fromAtM, slip: true }, { from: `${slip.id}:fwd`, to: slip.exitKey, toAtM: slip.toAtM });
        (rawNode(slip.spec.node).slipLanes ??= []).push({ direction: slip.spec.direction, backM: slip.backM });
    }
    return { config: result, slips };
}
