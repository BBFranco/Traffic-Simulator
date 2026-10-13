// One car's trip state (destination routing) at chosen moments: driveway, driveway wait, route - to see why a
// driveway hold outlives its driveway.
// node scripts/preview/tripprobe.mjs <config.json> <controller> <sensor> <seed> <carId> <atS,atS,...> [--outage]
//   [--routing=destination] [--warm=45000]   (atS: measured-window seconds, may be negative for the warm-up)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg, carIdArg, atList] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 45000));
const outage = process.argv.includes('--outage');
const dt = 0.1;
const carId = Number(carIdArg);
const ats = atList.split(',').map((s) => Math.round(Number(s) / dt));

const cfg = JSON.parse(readFileSync(path, 'utf8'));
const layout = buildLayout(cfg);
const e = new SimulationEngine(layout);
const modes = {};
const demand = {};
for (const a of layout.arterials) { modes[a.id] = controller; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand.spawnRatePerLanePerMin;
e.reset({
    seed: Number(seedArg), arterialModes: modes, demand, sensorMode: sensor, batteryBackedSensors: true,
    power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: opt('routing', 'destination'),
});
const plain = (v) => JSON.stringify(v, (k, x) => (k === 'road' || k === 'points' || k === 'samples' ? undefined : x));

for (let tick = 0; tick <= warm + Math.max(...ats); tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    if (ats.includes(m)) {
        const car = e._findCar(carId);
        console.log(`\n== measured ${(m * dt).toFixed(1)} s`);
        if (!car) { console.log('   car gone'); } else {
            console.log(`   ${e._roadName(car.road)} lane ${car.lane} @${car.distanceM.toFixed(2)} v ${car.speedMps.toFixed(2)} turnPath ${plain(car.turnPath && { key: car.turnPath.key, movement: car.turnPath.movement })}`);
            const { driveway, drivewayWait, ...rest } = car.trip ?? {};
            console.log(`   driveway ${plain(driveway && { id: driveway.drivewayId, road: e._roadName(driveway.road), sameRoad: driveway.road === car.road, fromM: driveway.fromM, atM: driveway.atM, side: driveway.side, crossesOncoming: driveway.crossesOncoming })}`);
            console.log(`   drivewayWait ${plain(drivewayWait)}  drivewayAhead ${Boolean(e._drivewayAhead(car))}`);
            console.log(`   trip ${plain(rest).slice(0, 600)}`);
        }
    }
    e.tick(dt);
}
