// Cars that drive through one stuck car in its own lane: where it is listed, and what each passer saw just before.
// node scripts/preview/passprobe.mjs <config.json> <controller> <sensor> <seed> <carId> <connector:dir> <fromS> <toS>
//   [--outage] [--routing=random] [--warm=36000]   (fromS/toS: measured-window seconds)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg, carIdArg, dirArg, fromArg, toArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 36000));
const outage = process.argv.includes('--outage');
const dt = 0.1;
const carId = Number(carIdArg);
const [cid, dirKey] = dirArg.split(':');
const from = Math.round(Number(fromArg) / dt);
const to = Math.round(Number(toArg) / dt);

const cfg = JSON.parse(readFileSync(path, 'utf8'));
const layout = buildLayout(cfg);
const e = new SimulationEngine(layout);
const modes = {};
const demand = {};
for (const a of layout.arterials) { modes[a.id] = controller; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand.spawnRatePerLanePerMin;
e.reset({
    seed: Number(seedArg), arterialModes: modes, demand, sensorMode: sensor, batteryBackedSensors: true,
    power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: opt('routing', 'random'),
});

let before = new Map();
let shown = 0;
for (let tick = 0; tick <= warm + to; tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    e.tick(dt);
    if (m < from) continue;
    const state = e.connectorState.get(cid)[dirKey];
    const stuck = e._findCar(carId);
    if (!stuck) break;
    const listed = state.lanes.flatMap((lane, i) => lane.cars.filter((c) => c.id === carId).map(() => i));
    const now = new Map();
    state.lanes.forEach((lane, i) => lane.cars.forEach((c) => now.set(c.id, { lane: i, d: c.distanceM, v: c.speedMps, cooldown: c.laneChangeCooldownS })));
    for (const [id, cur] of now) {
        const prev = before.get(id);
        if (!prev || id === carId || cur.lane !== stuck.lane) continue;
        if (prev.d < stuck.distanceM && cur.d >= stuck.distanceM && shown < 6) {
            shown += 1;
            console.log(`${(m * dt).toFixed(1)} s  ${id} passed stuck ${carId} (@${stuck.distanceM.toFixed(2)}, listed in lanes ${listed})`);
            console.log(`   before: lane ${prev.lane} @${prev.d.toFixed(2)} v ${prev.v.toFixed(2)}   after: lane ${cur.lane} @${cur.d.toFixed(2)} v ${cur.v.toFixed(2)}`);
            const lane = state.lanes[stuck.lane];
            console.log(`   lane ${stuck.lane} order now: ${lane.cars.slice(0, 10).map((c) => `${c.id}@${c.distanceM.toFixed(1)}`).join(' ')}`);
        }
    }
    before = now;
}
