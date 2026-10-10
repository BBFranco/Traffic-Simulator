// Who appears directly ahead of one stuck car on a connector, and from which lane - to see how cars get in front of it.
// node scripts/preview/cutinprobe.mjs <config.json> <controller> <sensor> <seed> <carId> <connector:dir> <fromS> <toS>
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

let lastLeader = null;
let lastLaneOf = new Map();
let printedLayout = false;
for (let tick = 0; tick <= warm + to; tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    e.tick(dt);
    if (m < from) continue;
    const state = e.connectorState.get(cid)[dirKey];
    if (!printedLayout) { console.log('layout', JSON.stringify(state.laneLayout)); printedLayout = true; }
    const car = e._findCar(carId);
    if (!car) { console.log(`${(m * dt).toFixed(1)} car gone`); break; }
    const laneOf = new Map();
    state.lanes.forEach((lane, i) => lane.cars.forEach((c) => laneOf.set(c.id, i)));
    const lane = state.lanes[car.lane];
    const i = lane.cars.indexOf(car);
    const leader = lane.cars[i - 1] ?? null;
    if (leader?.id !== lastLeader) {
        const was = leader ? lastLaneOf.get(leader.id) : undefined;
        console.log(`${(m * dt).toFixed(1)} s  car ${car.id} lane ${car.lane} @${car.distanceM.toFixed(2)} v ${car.speedMps.toFixed(2)}  new leader ${leader ? `${leader.id} @${leader.distanceM.toFixed(2)} len ${leader.lengthM} v ${leader.speedMps.toFixed(2)} was lane ${was}` : 'none'}`);
        lastLeader = leader?.id ?? null;
    }
    lastLaneOf = laneOf;
}
