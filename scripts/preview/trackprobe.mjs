// Road, lane, position and speed of some cars every tick over a window - to see where a car came from.
// node scripts/preview/trackprobe.mjs <config.json> <controller> <sensor> <seed> <id,id,...> <fromS> <toS>
//   [--outage] [--routing=random] [--warm=36000]   (fromS/toS: measured-window seconds)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg, idList, fromArg, toArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 36000));
const outage = process.argv.includes('--outage');
const dt = 0.1;
const ids = idList.split(',').map(Number);
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

const last = new Map();
for (let tick = 0; tick <= warm + to; tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    e.tick(dt);
    if (m < from) continue;
    for (const id of ids) {
        const car = e._findCar(id);
        const line = car ? `${e._roadName(car.road)} lane ${car.lane} turnPath ${Boolean(car.turnPath)} cooldown ${car.laneChangeCooldownS?.toFixed(1)}` : 'not on the network';
        if (last.get(id) === line) continue;
        last.set(id, line);
        console.log(`${(m * dt).toFixed(1)} s  ${id}: ${line}${car ? ` @${car.distanceM.toFixed(2)} v ${car.speedMps.toFixed(2)}` : ''}`);
    }
}
