// Generates the slip roads of a corridor config and writes them into it.
//
//   node scripts/slip-lanes.mjs <config.json> [--out <file>]
//
// Two kinds, both plain connectors joined to the roads they serve (see corridor.js's parseJoins()):
//  - a slip lane (resources/js/sim/slipLanes.js, shared with the Road Editor's slip-lane toggle): the left-turn
//    lane of an approach peels off before its stop line, runs round the corner outside the junction box and merges
//    into the kerb lane of the road it turns onto. Which approaches have one is the config's own `slipLanes`.
//  - the Lunnon and Prospect turn roads, which meet Jan Shoba the same way (a merge in, a peel-off out).
// Rerunning replaces what it generated (connector ids starting `slip_` and the `conn_lunnon_*` / `conn_prospect_*` turn roads), so
// the numbers in slipLanes.js are the only thing to tune. Reads the geometry from the engine, so a changed layout is a rerun.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildLayout, leftNormal } from '../resources/js/sim/corridor.js';
import { SimulationEngine } from '../resources/js/sim/engine.js';
import { lanePoint } from '../resources/js/sim/car.js';
import { CORNER_RADIUS_M, MERGE_ANGLE_DEG, RUN_ALONGSIDE_M, distanceOf, intersect, slipLaneSpecs, withSlipLanes, withoutSlipLanes } from '../resources/js/sim/slipLanes.js';

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
const round = (v) => Math.round(v * 10) / 10;
const pt = (p) => ({ xM: round(p.x), yM: round(p.y) });

const source = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : process.argv[2];

// Start from the config without anything generated earlier, so what the engine reads is the plain layout.
const config = withoutSlipLanes(source);
const layout = buildLayout(config);
const engine = new SimulationEngine(layout);
const roadOf = (key) => {
    const [id, dirKey = 'fwd'] = key.split(':');
    if (engine.carriagewaysById.has(key)) return engine.carriagewaysById.get(key);
    const dirs = engine.connectorDirs.get(id);
    if (dirs) return dirs[dirKey];
    return engine.carriagewaysById.get(dirKey === 'rev' ? `${id}:rev` : id);
};

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

const { config: result, slips } = withSlipLanes(config, slipLaneSpecs(source));
for (const slip of slips) console.log(`${slip.id}: peels ${slip.backM} m before the stop line, ${slip.lengthM} m long, merges at ${slip.toAtM} on ${slip.exitKey}`);

writeFileSync(outPath, JSON.stringify(result, null, 4) + '\n');
console.log(`wrote ${outPath}`);
