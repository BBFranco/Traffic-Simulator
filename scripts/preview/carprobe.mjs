// What one car on a cross street is held by at a given moment: each obstacle the step loop considers, its turn plan,
// and the junctions ahead of it.
// node scripts/preview/carprobe.mjs <config.json> <controller> <sensor> <seed> <carId> <atS,atS,...> [--outage]
//   [--routing=random] [--warm=22800]   (atS: measured-window seconds)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg, carIdArg, atList] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 22800));
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
    power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: opt('routing', 'random'),
});
const brief = (o) => (o ? JSON.stringify({ id: o.id, distanceM: o.distanceM?.toFixed?.(1), speedMps: o.speedMps, isSignal: o.isSignal, nodeId: o.nodeId }) : 'none');

for (let tick = 0; tick <= warm + Math.max(...ats); tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    if (ats.includes(m)) {
        const car = e._findCar(carId);
        console.log(`\n== measured ${(m * dt).toFixed(0)} s  power ${e.snapshot().powerState}`);
        if (!car) { console.log('   car gone'); continue; }
        console.log(`   car ${car.id} ${e._roadName(car.road)} lane ${car.lane} @${car.distanceM.toFixed(1)} v ${car.speedMps.toFixed(2)} turnPath ${Boolean(car.turnPath)}`);
        console.log(`   turnPlan ${JSON.stringify(car.turnPlan && { nodeId: car.turnPlan.nodeId, movement: car.turnPlan.movement, blockedSinceS: car.turnPlan.blockedSinceS, option: car.turnPlan.option && { ...car.turnPlan.option } })}`);
        console.log(`   released ${[...car.releasedNodeIds].join(',')}  crossRoll ${car.crossRollNodeId}`);
        for (const [cid, dirs] of e.connectorDirs) for (const [dirKey, dir] of Object.entries(dirs)) {
            if (dir.road !== car.road) continue;
            console.log(`   on ${cid}:${dirKey}  gates: ${dir.gates.map((g) => `${g.node.id}@${g.stopLineDistanceM.toFixed(0)}(${e.nodesInfo.get(g.node.id).controllerType})`).join(' ')}`);
            console.log(`   obstacleAhead ${brief(e._connectorObstacleAhead(dir, car))}`);
            console.log(`   joinObstacle ${brief(e._joinObstacle(`${cid}:${dirKey}`, car))}  drivewayHold ${brief(e._drivewayHold(car))}  letInHold ${brief(e._letInHold(car))}`);
            const lane = e.connectorState.get(cid)[dirKey].lanes[car.lane];
            const i = lane.cars.indexOf(car);
            console.log(`   index in lane ${i}, car ahead ${brief(lane.cars[i - 1])}`);
            for (const g of dir.gates) {
                const info = e.nodesInfo.get(g.node.id);
                const c = info.controller;
                console.log(`   node ${g.node.id}: type ${info.controllerType} phase ${c?.phase} state ${c?.state ?? c?.lightState?.()} inTurn ${c?.inTurn}`);
            }
            console.log(`   letIn on this road: ${JSON.stringify([...(e.letIn.get(car.road) ?? new Map())])}`);
        }
    }
    e.tick(dt);
}
