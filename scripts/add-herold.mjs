// Adds Herold Street to a corridor config (hatfield-realistic) and writes it back.
//
//   node scripts/add-herold.mjs <config.json> [--out <file>]
//
// Herold runs west of Jan Shoba (west to east: Herold, Jan Shoba, Dyer), straight and square to the grid, from a
// roundabout on Duxbury west of Jan Shoba, through a roundabout at Lunnon's west end (Lunnon stops there - the
// university), to a signalised T on Lynnwood with a westbound right-turn arrow. A node needs an arterial, so the
// node-less Duxbury and Lunnon stretches west of Jan Shoba (conn_duxbury_west, conn_lunnon_west) become short side
// arterials `duxbury_west` and `lunnon_west` over exactly the same ground, keeping their joins. Lynnwood gains
// Herold as its first junction, its lead-in carried on west past it.
//
// Also removes the first, wrongly placed (east side) version of Herold if the config still has it. Refuses to
// run twice - the conversions it makes are not undone.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildLayout } from '../resources/js/sim/corridor.js';
import { SimulationEngine } from '../resources/js/sim/engine.js';

const ROUNDABOUT_DIAMETER_M = 36;
const TURN_SHARE = 0.1;
/** How far Lynnwood's lead-in runs on west of Herold (m) - it used to start right where Herold meets it. */
const LYNNWOOD_WEST_LEAD_M = 100;

const round = (v) => Math.round(v * 10) / 10;
const add = (p, v, t) => ({ x: p.x + v.x * t, y: p.y + v.y * t });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const SIDE_DEMAND = { fluctuationPeriodS: 300, spawnRatePerLanePerMinMax: 3, spawnRatePerLanePerMinMin: 1, saturationFlowPerLanePerHour: 1250 };

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : process.argv[2];
const arterial = (id) => config.arterials.find((a) => a.id === id);
const connector = (id) => config.connectors.find((c) => c.id === id);
const lunnon = arterial('lunnon');
const lynnwood = arterial('lynnwood');
if (arterial('duxbury_west')) throw new Error('Herold (west) is already in this config.');

// --- Remove the east-side version.
const eastNode = lynnwood.intersections.find((n) => n.id === 'lynnwood_herold');
if (eastNode) {
    const duxNode = lynnwood.intersections.find((n) => n.id === 'lynnwood_duxbury');
    lynnwood.exitLengthM = round(lynnwood.exitLengthM + duxNode.distanceToNextM);
    delete duxNode.distanceToNextM;
    lynnwood.intersections = lynnwood.intersections.filter((n) => n !== eastNode);
}
if (lunnon.intersections.some((n) => n.id === 'herold_lunnon')) {
    const duxNode = lunnon.intersections.find((n) => n.id === 'lunnon_duxbury');
    lunnon.exitLengthM = duxNode.distanceToNextM;
    delete duxNode.distanceToNextM;
    lunnon.intersections = lunnon.intersections.filter((n) => n.id !== 'herold_lunnon');
}
config.arterials = config.arterials.filter((a) => a.id !== 'duxbury_herold');
config.connectors = config.connectors.filter((c) => c.id !== 'conn_herold');
config.joins = config.joins.filter((j) => ![j.from, j.to].some((ref) => ref.split(':')[0] === 'duxbury_herold'));
config.routing.blocks = config.routing.blocks.filter((b) => !b.id.startsWith('HER-') && !b.id.startsWith('DXH-') && b.id !== 'LYN-3');
const lun3 = config.routing.blocks.find((b) => b.id === 'LUN-3');
if (lun3) lun3.to = 'lunnon:end';

// --- Geometry. Duxbury and Lunnon west of Jan Shoba, and Lynnwood, all run on bearing 120.
const layout = buildLayout(config);
const along = layout.arterials.find((a) => a.id === 'lynnwood').heading;
const south = { x: -along.y, y: along.x };
const curveEnds = (id) => {
    const curve = connector(id).curve;
    return [curve[0], curve[curve.length - 1]].map((p) => ({ x: p.xM, y: p.yM }));
};
const [duxStart, duxEnd] = curveEnds('conn_duxbury_west');
const [lunStart, lunEnd] = curveEnds('conn_lunnon_west');
const duxLengthM = Math.hypot(duxEnd.x - duxStart.x, duxEnd.y - duxStart.y);
const lunLengthM = Math.hypot(lunEnd.x - lunStart.x, lunEnd.y - lunStart.y);
// Herold: square to the grid through Lunnon's west end.
const onDuxburyM = dot(sub(lunStart, duxStart), along);
const roundabout = add(duxStart, along, onDuxburyM);
const lynnJs = layout.arterials.find((a) => a.id === 'lynnwood').intersections[0];
const lynnwoodToJanShobaM = -dot(sub(lunStart, lynnJs.point), along);
const heroldOnLynnwood = add(lynnJs.point, along, -lynnwoodToJanShobaM);
const duxburyToLunnonM = dot(sub(lunStart, duxStart), south);
const lunnonToLynnwoodM = dot(sub(heroldOnLynnwood, lunStart), south);

// --- Duxbury west of Jan Shoba: a side arterial with the Herold roundabout on it.
const duxConn = connector('conn_duxbury_west');
config.arterials.push({
    id: 'duxbury_west',
    mode: 'fixed',
    name: 'Duxbury Road',
    lanes: duxConn.lanes,
    scope: 'side',
    demand: duxConn.demand ?? { ...SIDE_DEMAND },
    oneWay: false,
    origin: { xM: round(roundabout.x), yM: round(roundabout.y) },
    direction: 'eastbound',
    shortName: 'Duxbury',
    headingDeg: 120,
    exitLengthM: round(duxLengthM - onDuxburyM),
    targetSpeedKph: duxConn.targetSpeedKph,
    approachLengthM: round(onDuxburyM),
    intersections: [
        { id: 'herold_duxbury', name: 'Herold & Duxbury', control: 'roundabout', laneUse: { eastbound: ['all'], westbound: ['all'] }, roundaboutDiameterM: ROUNDABOUT_DIAMETER_M },
    ],
});

// --- Lunnon west of Jan Shoba: starts at the Herold roundabout (nothing west of it).
const lunConn = connector('conn_lunnon_west');
config.arterials.push({
    id: 'lunnon_west',
    mode: 'fixed',
    name: 'Lunnon Road',
    lanes: lunConn.lanes,
    scope: 'side',
    demand: lunConn.demand ?? { ...SIDE_DEMAND },
    oneWay: false,
    origin: { xM: lunStart.x, yM: lunStart.y },
    direction: 'eastbound',
    shortName: 'Lunnon',
    headingDeg: 120,
    exitLengthM: round(lunLengthM),
    targetSpeedKph: lunConn.targetSpeedKph,
    approachLengthM: 0,
    intersections: [
        { id: 'herold_lunnon', name: 'Herold & Lunnon', control: 'roundabout', laneUse: { eastbound: ['all'], westbound: ['all'] }, roundaboutDiameterM: ROUNDABOUT_DIAMETER_M },
    ],
});

config.connectors = config.connectors.filter((c) => c !== duxConn && c !== lunConn);
const renamed = { 'conn_duxbury_west:fwd': 'duxbury_west:fwd', 'conn_duxbury_west:rev': 'duxbury_west:rev', 'conn_lunnon_west:fwd': 'lunnon_west:fwd', 'conn_lunnon_west:rev': 'lunnon_west:rev' };
for (const join of config.joins) {
    join.from = renamed[join.from] ?? join.from;
    join.to = renamed[join.to] ?? join.to;
}

// --- Lynnwood: Herold is its first junction now; the lead-in carries on west of it. The fwd frame starts further
// west, so distances along it (a slip lane's peel-off) move by the same amount.
const fwdShiftM = LYNNWOOD_WEST_LEAD_M + lynnwoodToJanShobaM - lynnwood.approachLengthM;
lynnwood.origin = { xM: round(heroldOnLynnwood.x), yM: round(heroldOnLynnwood.y) };
lynnwood.approachLengthM = LYNNWOOD_WEST_LEAD_M;
lynnwood.intersections.unshift({
    id: 'lynnwood_herold',
    name: 'Lynnwood & Herold',
    laneUse: { eastbound: ['left_straight', 'straight'], westbound: ['straight', 'straight'] },
    turnLanes: { westbound: { right: { laneUse: 'right', lengthM: 40 } } },
    turnPhases: [{ direction: 'westbound', movement: 'right' }],
    distanceToNextM: round(lynnwoodToJanShobaM),
});
for (const join of config.joins) {
    if ((join.from === 'lynnwood' || join.from === 'lynnwood:fwd') && join.fromAtM != null) join.fromAtM = round(join.fromAtM + fwdShiftM);
    if ((join.to === 'lynnwood' || join.to === 'lynnwood:fwd') && join.toAtM != null) join.toAtM = round(join.toAtM + fwdShiftM);
}

config.connectors.push({
    id: 'conn_herold',
    mode: 'fixed',
    name: 'Herold Street',
    lanes: 2,
    demand: { ...SIDE_DEMAND },
    twoWay: true,
    stubStartM: 0,
    stubEndM: 0,
    turnChance: TURN_SHARE,
    crossChance: TURN_SHARE,
    targetSpeedKph: 60,
    linksArterialNodes: ['herold_duxbury', 'herold_lunnon', 'lynnwood_herold'],
});

// --- Routing blocks.
const dux1 = config.routing.blocks.find((b) => b.id === 'DUX-1');
dux1.from = 'herold_duxbury';
config.routing.blocks.push(
    { id: 'DXW-1', from: 'duxbury_west:start', to: 'herold_duxbury', tier: 2 },
    { id: 'LNW-1', from: 'herold_lunnon', to: 'lunnon_west:end', tier: 2 },
    { id: 'HER-1', from: 'herold_duxbury', to: 'herold_lunnon', tier: 2 },
    { id: 'HER-2', from: 'herold_lunnon', to: 'lynnwood_herold', tier: 2 },
    { id: 'LYN-0', from: 'lynnwood_herold', to: 'lynnwood_janshoba', tier: 4 }
);

// Check it builds before writing.
new SimulationEngine(buildLayout(config));
writeFileSync(outPath, JSON.stringify(config, null, 4) + '\n');
console.log(`Herold: Duxbury -> Lunnon ${round(duxburyToLunnonM)} m, Lunnon -> Lynnwood ${round(lunnonToLynnwoodM)} m`);
console.log(`Herold roundabout ${round(onDuxburyM)} m along Duxbury west, Lynnwood T ${round(lynnwoodToJanShobaM)} m west of Jan Shoba, Lynnwood fwd frame +${round(fwdShiftM)} m`);
console.log(`wrote ${outPath}`);
