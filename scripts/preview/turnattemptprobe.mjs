// Each tick one held turner tries to turn: whether it may enter, its landing, whether that is blocked, a let-in asked.
// node scripts/preview/turnattemptprobe.mjs <config.json> <controller> <sensor> <seed> <carId> <fromS> <toS>
//   [--outage] [--routing=random] [--warm=36000]   (fromS/toS: measured-window seconds)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg, carIdArg, fromArg, toArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 36000));
const outage = process.argv.includes('--outage');
const dt = 0.1;
const carId = Number(carIdArg);
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

let calls = null;
const show = (out) => (out && typeof out === 'object' ? JSON.stringify({ laneIndex: out.laneIndex, exitDistanceM: out.exitDistanceM?.toFixed(1) }) : String(out));
for (const name of ['_mayProceed', '_turnLanding', '_turnExitBlocked', '_waitToTurnIn', '_divertCarToArterial', '_divertCarToConnector', '_mayWaitInBox']) {
    const original = e[name].bind(e);
    e[name] = (...args) => {
        const out = original(...args);
        if (calls && name === '_turnExitBlocked' && out) {
            const [lanes, laneIndex, exitDistanceM] = args;
            const near = lanes[laneIndex].cars.filter((c) => Math.abs(c.distanceM - exitDistanceM) < 25);
            calls.push(`${name}=true near ${near.map((c) => `${c.id}@${c.distanceM.toFixed(1)}/v${c.speedMps.toFixed(1)}${e._letInHold(c) ? '/held' : ''}`).join(' ')}`);
        } else if (calls) calls.push(`${name}=${show(out)}`);
        return out;
    };
}
const original = e._maybeTurnOffConnector.bind(e);
e._maybeTurnOffConnector = (connector, dir, dirKey, car) => {
    if (car.id !== carId || tickNow < from) return original(connector, dir, dirKey, car);
    calls = [];
    const out = original(connector, dir, dirKey, car);
    const turnAhead = e.turningCars.filter((c) => c.turnPath.key.includes(`:${connector.id}:${dirKey}`)).map((c) => `${c.id}@${c.distanceM.toFixed(1)}`);
    console.log(`${((tickNow - warm) * dt).toFixed(1)} s lane ${car.lane} @${car.distanceM.toFixed(1)} held ${car.turnPlan?.blockedSinceS != null}  ${calls.join(' ') || '(nothing tried)'} -> ${out}  turning from here: ${turnAhead.join(' ')}`);
    calls = null;
    return out;
};
let tickNow = 0;
for (let tick = 0; tick <= warm + to; tick += 1) {
    tickNow = tick;
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    e.tick(dt);
}
