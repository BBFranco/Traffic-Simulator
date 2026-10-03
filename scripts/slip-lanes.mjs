// Generates the slip roads of a corridor config and writes them into it.
//
//   node scripts/slip-lanes.mjs <config.json> [--out <file>]
//
// Two kinds, both plain connectors joined to the roads they serve (see corridor.js's parseJoins()):
//  - a slip lane: the left-turn lane of an approach peels off `backM` before its stop line (a join with
//    `slip: true`), runs round the corner outside the junction box on its own lane, and merges into the kerb
//    lane of the road it turns onto (a join with `toAtM`, where the cars give way).
//  - the Lunnon and Prospect turn roads, which meet Jan Shoba the same way (a merge in, a peel-off out).
// Rerunning replaces what it generated (connector ids starting `slip_` and the `conn_lunnon_*` / `conn_prospect_*` turn roads), so
// the numbers below are the only thing to tune. Reads the geometry from the engine, so a changed layout is a rerun.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildLayout, compassDirection, leftNormal } from '../resources/js/sim/corridor.js';
import { SimulationEngine } from '../resources/js/sim/engine.js';
import { lanePoint } from '../resources/js/sim/car.js';

/** Left-turn lanes that leave as slip roads: the node and the compass direction of travel of the approach. */
const SLIPS = [
    { node: 'duxbury_janshoba', direction: 'southbound' },
    { node: 'lynnwood_duxbury', direction: 'eastbound' },
    { node: 'burnett_janshoba', direction: 'northbound' },
];
/** Centreline radius of a slip road's corner, m. */
const CORNER_RADIUS_M = 12;
/** The slip lane runs this far alongside the road it turns onto, then angles in over MERGE_ANGLE_DEG. */
const RUN_ALONGSIDE_M = 10;
const MERGE_ANGLE_DEG = 15;
const SLIP_SPEED_KPH = 30;
/** The Lunnon and Prospect turn roads (connector ids) and which way each runs: `in` merges the side street's traffic into Jan Shoba, `out` takes Jan Shoba's into it. */
const TURN_ROADS = [
    { id: 'conn_lunnon_w_on', kind: 'in' },
    { id: 'conn_lunnon_w_off', kind: 'out' },
    { id: 'conn_lunnon_e_off', kind: 'out' },
    { id: 'conn_lunnon_e_on', kind: 'in' },
    { id: 'conn_prospect_w_on', kind: 'in' },
    { id: 'conn_prospect_w_off', kind: 'out' },
    { id: 'conn_prospect_e_off', kind: 'out' },
    { id: 'conn_prospect_e_on', kind: 'in' },
];

const add = (p, v, t) => ({ x: p.x + v.x * t, y: p.y + v.y * t });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const round = (v) => Math.round(v * 10) / 10;
const pt = (p) => ({ xM: round(p.x), yM: round(p.y) });

function intersect(p, u, q, v) {
    const denom = u.x * v.y - u.y * v.x;
    if (Math.abs(denom) < 1e-9) throw new Error('parallel lines');
    const t = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / denom;
    return add(p, u, t);
}

/** The distance along `road` (lane `lane`) whose point is nearest `target`, searched over [from, to] metres. */
function distanceOf(road, lane, target, from, to) {
    let best = from;
    let bestD = Infinity;
    for (let d = from; d <= to; d += 0.25) {
        const p = lanePoint(road, lane, d).point;
        const dist = Math.hypot(p.x - target.x, p.y - target.y);
        if (dist < bestD) [best, bestD] = [d, dist];
    }
    return round(best);
}

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : process.argv[2];

// Start from the config without anything generated earlier, so what the engine reads is the plain layout.
const generatedConnector = (id) => id.startsWith('slip_');
config.connectors = config.connectors.filter((c) => !generatedConnector(c.id));
config.joins = config.joins.filter((j) => ![j.from, j.to].some((ref) => generatedConnector(ref.split(':')[0])));
for (const arterial of config.arterials) for (const node of arterial.intersections) delete node.slipLanes;

const layout = buildLayout(config);
const engine = new SimulationEngine(layout);
const roadOf = (key) => {
    const [id, dirKey = 'fwd'] = key.split(':');
    if (engine.carriagewaysById.has(key)) return engine.carriagewaysById.get(key);
    const dirs = engine.connectorDirs.get(id);
    if (dirs) return dirs[dirKey];
    return engine.carriagewaysById.get(dirKey === 'rev' ? `${id}:rev` : id);
};
const nodeById = new Map(layout.arterials.flatMap((a) => a.intersections.map((n) => [n.id, n])));
const rawNode = (id) => config.arterials.flatMap((a) => a.intersections).find((n) => n.id === id);

const generated = [];
for (const spec of SLIPS) {
    const node = nodeById.get(spec.node);
    const approach = node.approaches.find((a) => compassDirection(a.heading) === spec.direction);
    const gate = engine.gatesByApproachId.get(approach.id);
    const left = gate.turnOptions.find((o) => o.movement === 'left');
    if (!left) throw new Error(`${spec.node} ${spec.direction}: no left turn there`);

    // The road the slip comes off, and its left-turn lane.
    const fromRoad = gate.carriageway ?? gate.dir;
    const fromKey = gate.carriageway ? gate.carriageway.id : `${gate.connector.id}:${gate.dirKey}`;
    const pocketSlot = gate.slotLaneUse.findIndex((moves) => moves.includes('left') && !moves.includes('straight'));
    if (pocketSlot < 0) throw new Error(`${spec.node} ${spec.direction}: no left-only lane`);
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
    const exitKey = exit.key;
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
    const fromAtM = round(gate.stopLineDistanceM - backM);
    const toAtM = distanceOf(exitDir.road, exitKerbLane, p2, exit.entryM, exit.entryM + 120);
    const id = `slip_${spec.node}_${spec.direction}`;
    const name = ''; // unlabelled: it is the road it serves
    generated.push({ spec, id, backM, fromKey, exitKey, fromAtM, toAtM, curve: [p0, corner, p1, c2, p2].map(pt), name });
    console.log(`${id}: peels ${backM} m before the stop line, ${round(leg * 2 + RUN_ALONGSIDE_M + laneW / Math.sin(alpha))} m long, merges at ${toAtM} on ${exitKey}`);
}

/** The Lunnon and Prospect turn roads: built like the slip lanes - round the corner, a stretch on their own lane beside Jan Shoba, then angled into (or out of) its kerb lane. */
const lunnon = [];
for (const { id, kind } of TURN_ROADS) {
    const joins = config.joins;
    const lunnonKey = kind === 'in' ? joins.find((j) => j.to === `${id}:fwd` && j.fromAtM == null && j.toAtM == null).from : joins.find((j) => j.from === `${id}:fwd` && j.fromAtM == null && j.toAtM == null).to;
    const jan = kind === 'in' ? joins.find((j) => j.from === `${id}:fwd` && j.toAtM != null) : joins.find((j) => j.to === `${id}:fwd` && j.fromAtM != null);
    const janKey = kind === 'in' ? jan.to : jan.from;
    const lunnonRoad = roadOf(lunnonKey);
    const janRoad = roadOf(janKey);
    const lunnonLane = lunnonRoad.laneLayout?.kerbSlots ?? 0;
    // Lunnon's lane where this road meets it: the end of the road it comes from, or the start of the road it leads to.
    const lunnonEnd = kind === 'in' ? lanePoint(lunnonRoad.road, lunnonLane, lunnonRoad.lengthM ?? engine.connectorsById.get(lunnonKey.split(':')[0]).routeLengthM) : lanePoint(lunnonRoad.road, lunnonLane, 0);
    const janLane = janRoad.laneLayout.kerbSlots;
    const janLength = janRoad.lengthM ?? engine.connectorsById.get(janKey.split(':')[0]).routeLengthM;
    // Lunnon's lane line towards Jan Shoba, and the line a lane further out beside Jan Shoba's kerb lane where the turn road runs (Jan Shoba bends, so settle on it).
    const towardJanShoba = kind === 'in' ? lunnonEnd.heading : { x: -lunnonEnd.heading.x, y: -lunnonEnd.heading.y };
    const laneW = janRoad.road.laneWidthM;
    const outwardAt = (d) => {
        const lane = lanePoint(janRoad.road, janLane, d);
        const out = leftNormal(lane.heading);
        return { point: add(lane.point, out, laneW), heading: lane.heading, out };
    };
    let corner = lunnonEnd.point;
    let at = distanceOf(janRoad.road, janLane, lunnonEnd.point, 0, janLength);
    for (let pass = 0; pass < 4; pass += 1) {
        const line = outwardAt(at);
        corner = intersect(lunnonEnd.point, towardJanShoba, line.point, line.heading);
        at = distanceOf(janRoad.road, janLane, corner, Math.max(0, at - 60), Math.min(janLength, at + 60));
    }
    const { heading: e, out } = outwardAt(at);
    const lunnonLegM = Math.hypot(corner.x - lunnonEnd.point.x, corner.y - lunnonEnd.point.y);
    // Along Jan Shoba the turn road is ahead of the corner when it merges in, behind it when it leaves.
    const sign = kind === 'in' ? 1 : -1;
    const p1 = add(corner, e, sign * CORNER_RADIUS_M);
    const c2 = add(p1, e, sign * RUN_ALONGSIDE_M);
    const alpha = (MERGE_ANGLE_DEG * Math.PI) / 180;
    const dir2 = { x: sign * e.x * Math.cos(alpha) - out.x * Math.sin(alpha), y: sign * e.y * Math.cos(alpha) - out.y * Math.sin(alpha) };
    const p2 = add(c2, dir2, laneW / Math.sin(alpha));
    const atM = distanceOf(janRoad.road, janLane, p2, Math.max(0, at - 120), Math.min(janLength, at + 120));
    // Drawn and driven in travel order: Lunnon to Jan Shoba for a merge, Jan Shoba to Lunnon for a peel-off.
    const curve = kind === 'in' ? [lunnonEnd.point, corner, p1, c2, p2] : [p2, c2, p1, corner, lunnonEnd.point];
    if (kind === 'in') jan.toAtM = atM;
    else jan.fromAtM = atM;
    config.connectors.find((c) => c.id === id).curve = curve.map(pt);
    lunnon.push(`${id} ${kind}: ${round(lunnonLegM + CORNER_RADIUS_M + RUN_ALONGSIDE_M + laneW / Math.sin(alpha))} m, Jan Shoba at ${atM}`);
}
lunnon.forEach((line) => console.log(line));

for (const g of generated) {
    // The curve is anchors at the even indices and controls at the odd ones: P0, corner, P1, run control, P2.
    const [p0, corner, p1, c2, p2] = g.curve;
    config.connectors.push({ id: g.id, mode: 'fixed', name: g.name, curve: [p0, corner, p1, c2, p2], lanes: 1, twoWay: false, turnChance: 0, crossChance: 0, targetSpeedKph: SLIP_SPEED_KPH });
    config.joins.push({ from: g.fromKey, to: `${g.id}:fwd`, fromAtM: g.fromAtM, slip: true }, { from: `${g.id}:fwd`, to: g.exitKey, toAtM: g.toAtM });
    const node = rawNode(g.spec.node);
    (node.slipLanes ??= []).push({ direction: g.spec.direction, backM: g.backM });
}

writeFileSync(outPath, JSON.stringify(config, null, 4) + '\n');
console.log(`wrote ${outPath}`);
