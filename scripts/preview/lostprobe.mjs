// Where map-edge arrivals are lost: per entry lane, the seconds it sat blocked (an arrival due but the lane mouth full)
// and its share of arrivalsLost, over the measured window. node scripts/preview/lostprobe.mjs <config.json> <controller>
//   <sensor> <seed> [--routing=destination] [--warm=49800] [--measure=54000] [--outage] [--top=12]
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 49800));
const measure = Number(opt('measure', 54000));
const outage = process.argv.includes('--outage');
const dt = 0.1;

const layout = buildLayout(JSON.parse(readFileSync(path, 'utf8')));
const e = new SimulationEngine(layout);
const modes = {};
const demand = {};
for (const a of layout.arterials) { modes[a.id] = controller; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand.spawnRatePerLanePerMin;
e.reset({
    seed: Number(seedArg), arterialModes: modes, demand, sensorMode: sensor, batteryBackedSensors: true,
    power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: opt('routing', 'destination'),
});

const entryLanes = () => [
    ...[...e.carriagewayState.entries()].flatMap(([id, s]) => s.lanes.map((lane, i) => [`${id} lane ${i}`, lane])),
    ...[...e.connectorState.entries()].flatMap(([id, s]) => ['fwd', 'rev'].flatMap((dir) => (s[dir]?.lanes ?? []).map((lane, i) => [`${id}:${dir} lane ${i}`, lane]))),
].filter(([, lane]) => !lane.isTurnLane && lane.nextArrivalS !== undefined);

const blocked = new Map();
let lostAtStart = 0;
for (let tick = 0; tick < warm + measure; tick += 1) {
    const m = tick - warm;
    if (m === 0) { e.resetStats(); lostAtStart = e.accounting.arrivalsLost; }
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    const before = e.accounting.arrivalsLost;
    e.tick(dt);
    if (m < 0) continue;
    const delta = e.accounting.arrivalsLost - before;
    if (delta <= 0) continue;
    const stuck = entryLanes().filter(([, lane]) => lane.timerS >= lane.nextArrivalS);
    for (const [name] of stuck) {
        const row = blocked.get(name) ?? { seconds: 0, lost: 0 };
        row.seconds += dt;
        row.lost += delta / stuck.length;
        blocked.set(name, row);
    }
}
const total = e.accounting.arrivalsLost - lostAtStart;
console.log(`arrivalsLost ${total.toFixed(1)} over ${(measure * dt / 60).toFixed(0)} min`);
for (const [name, row] of [...blocked.entries()].sort((a, b) => b[1].lost - a[1].lost).slice(0, Number(opt('top', 12)))) {
    console.log(name.padEnd(46), 'lost', row.lost.toFixed(1).padStart(5), `(${(row.lost / total * 100).toFixed(0)}%)`.padStart(6), 'blocked', `${row.seconds.toFixed(0)} s`.padStart(7));
}
