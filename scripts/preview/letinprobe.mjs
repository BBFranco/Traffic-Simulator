// Why a held turner isn't let in: its hold, the let-in on its landing lane, and the cars round where it would land.
// node scripts/preview/letinprobe.mjs <config.json> <controller> <sensor> <seed> <carId> <fromS> <toS> <everyS>
//   [--outage] [--routing=random] [--warm=36000]   (fromS/toS: measured-window seconds)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg, carIdArg, fromArg, toArg, everyArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 36000));
const outage = process.argv.includes('--outage');
const dt = 0.1;
const carId = Number(carIdArg);
const from = Math.round(Number(fromArg) / dt);
const to = Math.round(Number(toArg) / dt);
const every = Math.round(Number(everyArg) / dt);

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

const lanesOf = (road) => {
    for (const [, s] of e.carriagewayState) if (s.lanes[0]?.cars && s.road === road) return s.lanes;
    for (const [, dirs] of e.connectorState) for (const s of Object.values(dirs)) if (s.road === road) return s.lanes;
    return null;
};
let lastAsk = null;
for (let tick = 0; tick <= warm + to; tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    e.tick(dt);
    if (m < from) continue;
    const car = e._findCar(carId);
    if (!car) { console.log(`${(m * dt).toFixed(1)} car gone`); break; }
    let ask = null;
    for (const [road, lanes] of e.letIn) for (const [laneIndex, w] of lanes) if (w.carId === carId) ask = { road, laneIndex, ...w };
    const askKey = ask ? `${ask.laneIndex}@${ask.exitDistanceM.toFixed(1)}` : 'none';
    if ((m - from) % every !== 0 && askKey === lastAsk) continue;
    lastAsk = askKey;
    const tp = car.turnPlan;
    console.log(`${(m * dt).toFixed(1)} s  ${e._roadName(car.road)} lane ${car.lane} @${car.distanceM.toFixed(1)} v ${car.speedMps.toFixed(2)} blockedSince ${tp?.blockedSinceS?.toFixed(1)} plan ${tp?.nodeId}/${tp?.option?.movement}`);
    const turning = e.turningCars.filter((c) => c.turnPath.key.includes(tp?.nodeId)).map((c) => `${c.id} ${c.turnPath.key} @${c.distanceM.toFixed(1)}/${c.turnPath.lengthM.toFixed(1)} v ${c.speedMps.toFixed(1)}`);
    if (turning.length) console.log(`   turning: ${turning.join(' | ')}`);
    if (!ask) { console.log('   no let-in'); continue; }
    const lane = lanesOf(ask.road)?.[ask.laneIndex];
    const near = lane?.cars.filter((c) => Math.abs(c.distanceM - ask.exitDistanceM) < 30).map((c) => `${c.id}@${c.distanceM.toFixed(1)}/${c.speedMps.toFixed(1)}${e._letInHold(c) ? 'H' : ''}`);
    console.log(`   let-in ${e._roadName(ask.road)} lane ${ask.laneIndex} at ${ask.exitDistanceM.toFixed(1)} until ${ask.untilS.toFixed(0)} (now ${e.simTimeS.toFixed(0)}); near: ${near?.join(' ')}`);
}
