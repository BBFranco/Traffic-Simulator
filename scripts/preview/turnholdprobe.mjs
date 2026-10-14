// Every _holdForTurn / _waitToTurnIn at one node over a window: who held, why (landing lane cars), and the signal.
// node scripts/preview/turnholdprobe.mjs <config.json> <controller> <sensor> <seed> <nodeId> <fromS> <toS>
//   [--outage] [--routing=random] [--warm=36000]   (fromS/toS: measured-window seconds)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg, nodeId, fromArg, toArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 36000));
const outage = process.argv.includes('--outage');
const dt = 0.1;
const [from, to] = [fromArg, toArg].map((s) => Math.round(Number(s) / dt));

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
let live = false;
const t = () => ((e.tickNo - warm) * dt).toFixed(1);
const holdForTurn = e._holdForTurn.bind(e);
e._holdForTurn = (car, nid, canGoStraight) => {
    if (live && nid === nodeId) console.log(`${t()} hold ${car.id} lane ${car.lane} blk ${car.turnPlan.blockedSinceS?.toFixed(1) ?? "new"} canGoStraight ${canGoStraight} turning: ${e.turningCars.filter((c) => c.turnPath.key?.includes(nodeId)).map((c) => `${c.id}@${c.distanceM.toFixed(1)}v${c.speedMps.toFixed(1)} ${c.turnPath.key}`).join(" ")}`);
    return holdForTurn(car, nid, canGoStraight);
};
const waitToTurnIn = e._waitToTurnIn.bind(e);
e._waitToTurnIn = (car, road, laneIndex, exitDistanceM) => {
    if (live && car.turnPlan?.nodeId === nodeId) {
        const cars = e.lockupWatch._liveCars().map((x) => x.car).filter((c) => c.road === road && c.lane === laneIndex && c.distanceM < exitDistanceM + 25);
        console.log(`${t()}   exit blocked ${car.id} -> lane ${laneIndex} @${exitDistanceM.toFixed(1)}: ${cars.map((c) => `${c.id}@${c.distanceM.toFixed(1)}v${c.speedMps.toFixed(1)}`).join(' ')}`);
    }
    return waitToTurnIn(car, road, laneIndex, exitDistanceM);
};
for (let tick = 0; tick <= warm + to; tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    live = m >= from;
    e.tick(dt);
}
