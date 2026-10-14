// Dumps one roundabout's ring state over a time window, to see what each car going round is waiting on.
// node scripts/preview/ringprobe.mjs <config.json> <controller> <sensor> <seed> <nodeId> <fromS> <toS> [--every=5]
//   [--routing=destination] [--warm=36000] [--outage]   (fromS/toS are measured-window seconds)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { carRenderPoint } from '../../resources/js/sim/car.js';

const [path, controller, sensor, seedArg, nodeId, fromS, toS] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 36000));
const everyS = Number(opt('every', 5));
const outage = process.argv.includes('--outage');
const dt = 0.1;

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
const info = e.nodesInfo.get(nodeId);
const { node } = info;
const deg = (p) => ((Math.atan2(p.y - node.point.y, p.x - node.point.x) * 180) / Math.PI).toFixed(0);
const approachName = (id) => {
    const a = node.approaches.find((x) => x.id === id);
    return a ? `${id}` : id;
};

const endTick = warm + Math.round(Number(toS) / dt);
for (let tick = 0; tick < endTick; tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    e.tick(dt);
    if (m < Number(fromS) / dt || m % Math.round(everyS / dt)) continue;

    console.log(`\n== t=${(m * dt).toFixed(1)} s  ${nodeId}  openTo=[${[...(info.roundaboutOpenTo ?? [])].join(',')}]  exitHeld=[${[...(info.roundaboutExitHeld ?? [])].map((c) => c.id).join(',')}]`);
    console.log(`   occupants: ${[...info.roundaboutOccupants.values()].map((o) => `${o.car.id}(from ${approachName(o.approachId)}, passes ${[...o.passes].join('/')}, entered ${o.entered})`).join('; ')}`);
    const onRings = e._carsOnRings().get(nodeId);
    for (const car of e.turningCars.filter((c) => c.turnPath.ringNodeId === nodeId)) {
        const p = carRenderPoint(car);
        const r = Math.hypot(p.x - node.point.x, p.y - node.point.y);
        const tp = car.turnPath;
        const exitBlocked = e._turnExitBlocked(e._turnTargetLanes(tp), car.lane, tp.exitDistanceM, car.lengthM);
        const leader = e._ringLeader(car, onRings);
        const leaderCar = leader && onRings.cars.find((c) => Math.abs(car.distanceM + ((((c.angle - Math.atan2(p.y - node.point.y, p.x - node.point.x)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * node.roundabout.circulatingRadiusM - leader.distanceM) < 0.01 && c.car !== car);
        console.log(`   car ${car.id} ${car.vehicleType} key=${tp.key} angle ${deg(p)} r ${r.toFixed(1)} v ${car.speedMps.toFixed(2)} along ${car.distanceM.toFixed(1)}/${tp.lengthM.toFixed(1)} -> ${e._roadName(car.road)} lane ${car.lane} exitBlocked ${exitBlocked} ringLeader ${leaderCar ? leaderCar.car.id : leader ? '?' : '-'}${leader ? ` gap ${(leader.distanceM - car.distanceM).toFixed(1)}` : ''}`);
    }
    for (const a of e._roundaboutArrivals(info)) {
        console.log(`   waiting car ${a.car.id} at ${a.approachId} v ${a.car.speedMps.toFixed(2)} plan ${a.car.turnPlan?.movement ?? '-'} since ${info.roundaboutWaiting.get(a.car)?.toFixed(0)}`);
    }
}
