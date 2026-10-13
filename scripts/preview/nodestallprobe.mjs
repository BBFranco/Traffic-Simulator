// Where the waiting at one signalised junction goes, over the measured window: the stage greens it actually ran, stood
// car-seconds on each approach split pocket / turner still in a through lane / through, and turners stood inside the box
// split waiting for a gap / landing lane full / queued behind another turner.
// node scripts/preview/nodestallprobe.mjs <config.json> <controller> <sensor> <seed> <nodeId>
//   [--routing=destination] [--warm=49800] [--measure=54000] [--outage] [--reach=150]   (reach: metres back from the stop line)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg, nodeId] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 49800));
const measure = Number(opt('measure', 54000));
const reach = Number(opt('reach', 150));
const outage = process.argv.includes('--outage');
const dt = 0.1;
const STOOD_MPS = 0.5;

const layout = buildLayout(JSON.parse(readFileSync(path, 'utf8')));
const e = new SimulationEngine(layout);
const modes = {};
const demand = {};
for (const a of layout.arterials) { modes[a.id] = controller; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand.spawnRatePerLanePerMin;
e.reset({
    seed: Number(seedArg), arterialModes: modes, demand, sensorMode: sensor, batteryBackedSensors: true,
    power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: opt('routing', 'destination'),
});

const gateName = (g) => g.carriageway?.id ?? `${g.connector.id}:${g.dirKey}`;
const gateLanes = (g) => (g.carriageway ? e.carriagewayState.get(g.carriageway.id).lanes : e.connectorState.get(g.connector.id)[g.dirKey].lanes);
const add = (map, key, v) => map.set(key, (map.get(key) ?? 0) + v);

const greens = new Map(); // stage label -> [durations]
let stage = null;
let stageStartS = 0;
const approach = new Map(); // gate | category -> stood car-seconds
const box = new Map(); // movement | reason -> stood car-seconds
const stillSince = new Map(); // car id -> { sinceS, where }
const longest = []; // { id, seconds, where }

const stageLabel = (c) => (c.phaseState === 'green' ? `${c.phase === 0 ? 'arterial' : 'cross'}${c.inTurn ? ' turn' : ''}` : null);

for (let tick = 0; tick < warm + measure; tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    e.tick(dt);
    if (m < 0) continue;
    const now = e.simTimeS;
    const info = e.nodesInfo.get(nodeId);

    const label = info.controller ? stageLabel(info.controller) : null;
    if (label !== stage) {
        if (stage) (greens.get(stage) ?? greens.set(stage, []).get(stage)).push(now - stageStartS);
        stage = label;
        stageStartS = now;
    }

    const seen = new Set();
    for (const g of [...info.arterialGates, ...info.crossGates]) {
        gateLanes(g).forEach((lane, laneIndex) => {
            for (const car of lane.cars) {
                const back = g.stopLineDistanceM - car.distanceM;
                if (back < -1 || back > reach || car.speedMps > STOOD_MPS) continue;
                const turning = car.turnPlan?.nodeId === nodeId && car.turnPlan.movement && car.turnPlan.movement !== 'straight';
                const category = lane.isTurnLane ? `pocket (${car.turnPlan?.movement ?? '?'})` : turning ? `${car.turnPlan.movement} turner in through lane` : 'through';
                add(approach, `${gateName(g)} | ${category}`, dt);
                seen.add(car.id);
                if (!stillSince.has(car.id)) stillSince.set(car.id, { sinceS: now, where: `${gateName(g)} lane ${laneIndex} ${category}` });
            }
        });
    }
    for (const car of e.turningCars) {
        const p = car.turnPath;
        if (!p || p.driveway || p.ringNodeId || !p.key?.includes(nodeId) || car.speedMps > STOOD_MPS) continue;
        const exitBlocked = e._turnExitBlocked(e._turnTargetLanes(p), car.lane, p.exitDistanceM, car.lengthM);
        const reason = p.boxWait ? 'waiting for a gap' : exitBlocked ? 'landing lane full' : 'behind another turner';
        add(box, `${p.key.split('@').at(0)} ${p.movement} -> ${e._roadName(car.road)} | ${reason}`, dt);
        seen.add(car.id);
        const s = stillSince.get(car.id);
        if (s) s.where += ` / box: ${reason}`;
        else stillSince.set(car.id, { sinceS: now, where: `box ${p.movement} -> ${e._roadName(car.road)}: ${reason}` });
    }
    for (const [id, s] of stillSince) {
        if (seen.has(id)) continue;
        longest.push({ id, seconds: now - s.sinceS, where: s.where });
        stillSince.delete(id);
    }
}

console.log(`${controller}/${sensor} seed ${seedArg} at ${nodeId}, ${(measure * dt / 60).toFixed(0)} min measured\n`);
console.log('Greens run (s): stage  n  mean  p90  max');
for (const [label, ds] of greens) {
    const s = [...ds].sort((a, b) => a - b);
    console.log(' ', label.padEnd(14), String(s.length).padStart(4), (s.reduce((a, b) => a + b, 0) / s.length).toFixed(1).padStart(6), s[Math.floor(s.length * 0.9)].toFixed(1).padStart(6), s.at(-1).toFixed(1).padStart(6));
}
console.log('\nStood car-seconds on the approaches (per measured hour):');
for (const [k, v] of [...approach].sort((a, b) => b[1] - a[1])) console.log(' ', k.padEnd(60), (v / (measure * dt / 3600)).toFixed(0).padStart(7));
console.log('\nStood car-seconds inside the box (per measured hour):');
for (const [k, v] of [...box].sort((a, b) => b[1] - a[1])) console.log(' ', k.padEnd(78), (v / (measure * dt / 3600)).toFixed(0).padStart(7));
console.log('\nLongest unbroken stand (approach + box):');
for (const l of longest.sort((a, b) => b.seconds - a.seconds).slice(0, 8)) console.log(`  car ${l.id} ${l.seconds.toFixed(0)} s - ${l.where.split(' / ').filter((w, i, a) => a.indexOf(w) === i).join(' / ')}`);
