// Who sits around a let-in's landing spot, and the turners holding it, over a window - to see why a let-in never ends.
// node scripts/preview/landingprobe.mjs <config.json> <controller> <sensor> <seed> <roadCarId> <fromS> <toS> <everyS>
//   [--outage] [--routing=random] [--warm=36000]   (fromS/toS: measured-window seconds; roadCarId: a car on the road)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg, carIdArg, fromArg, toArg, everyArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 36000));
const outage = process.argv.includes('--outage');
const dt = 0.1;
const [from, to, every] = [fromArg, toArg, everyArg].map((s) => Math.round(Number(s) / dt));

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
const allCars = () => [...e.lockupWatch._liveCars().map((x) => x.car), ...e.turningCars];
let road = null;
for (let tick = 0; tick <= warm + to; tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    e.tick(dt);
    if (m < from || (m - from) % every !== 0) continue;
    const anchor = allCars().find((c) => c.id === Number(carIdArg)) ?? null;
    road = anchor?.road ?? road;
    const lanes = e.letIn.get(road);
    const signal = e.snapshot();
    console.log(`\n== ${(m * dt).toFixed(1)} s  tick ${e.tickNo}  anchor ${anchor ? `${anchor.id}@${anchor.distanceM.toFixed(1)} v${anchor.speedMps.toFixed(1)} L${anchor.lengthM}` : 'gone'}`);
    for (const [lane, w] of lanes ?? []) {
        const turner = allCars().find((c) => c.id === w.carId);
        console.log(`  letIn lane ${lane}: car ${w.carId} exit ${w.exitDistanceM.toFixed(1)} until ${w.untilS.toFixed(0)} (now ${e.simTimeS.toFixed(0)}) held ${w.heldPlan ? `blk ${w.heldPlan.blockedSinceS?.toFixed(0)} seen ${w.heldPlan.heldSeenTick}` : '-'} active ${e._letInActive(w)}`
            + `  turner ${turner ? `${turner.turnPath ? 'TURNING' : turner.road?.id ?? '?'} @${turner.distanceM.toFixed(1)} v${turner.speedMps.toFixed(1)} plan ${JSON.stringify(turner.turnPlan && { n: turner.turnPlan.nodeId, mv: turner.turnPlan.movement, blk: turner.turnPlan.blockedSinceS })}` : 'gone'}`);
        const near = allCars().filter((c) => c.road === road && c.lane === lane && !c.turnPath && c.distanceM < w.exitDistanceM + 25).map((c) => `${c.id}@${c.distanceM.toFixed(1)}v${c.speedMps.toFixed(1)}L${c.lengthM}`);
        console.log(`    lane ${lane} 0-${(w.exitDistanceM + 25).toFixed(0)} m: ${near.join(' ')}`);
    }
}
