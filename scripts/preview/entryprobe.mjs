// Every car that arrives on a connector lane between two moments: where it lands, the lane's cars around it then, and
// the call stack that put it there. node scripts/preview/entryprobe.mjs <config.json> <controller> <sensor> <seed>
//   <connector:dir> <lane> <fromS> <toS> [--outage] [--routing=random] [--warm=36000]   (measured-window seconds)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg, dirArg, laneArg, fromArg, toArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 36000));
const outage = process.argv.includes('--outage');
const dt = 0.1;
const [connId, dirKey] = dirArg.split(':');
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
const laneNow = () => e.connectorState.get(connId)[dirKey].lanes[Number(laneArg)];
let watched = null;
const watch = () => {
    const lane = laneNow();
    if (lane.cars === watched) return;
    watched = lane.cars;
    const push = watched.push;
    watched.push = function (...cars) {
        const m = e.tickNo - warm;
        if (m >= from && m <= to) for (const car of cars) {
            const around = this.map((c) => `${c.id}@${c.distanceM.toFixed(1)}`).join(' ');
            console.log(`\n${(m * dt).toFixed(1)} s: car ${car.id} lands @${car.distanceM.toFixed(1)} len ${car.lengthM.toFixed(1)}; lane had: ${around}`);
            console.log(new Error().stack.split('\n').slice(2, 6).join('\n'));
        }
        return push.apply(this, cars);
    };
};
for (let tick = 0; tick <= warm + to; tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    if (m >= from - 1) watch();
    e.tick(dt);
}
