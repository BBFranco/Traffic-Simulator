// Replays one batch run and reports where vehicles get stuck: stopped-car counts per road over time and the
// longest-stopped cars at chosen checkpoints.
// node scripts/preview/stuckprobe.mjs <config.json> <controller> <sensor> <seed> [--outage] [--routing=destination]
//   [--warm=36000] [--duration=36000] [--every=300] [--top=25]
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg] = process.argv.slice(2);
const opt = (name, fallback) => {
    const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : fallback;
};
const outage = process.argv.includes('--outage');
const routing = opt('routing', 'destination');
const warm = Number(opt('warm', 36000));
const duration = Number(opt('duration', 36000));
const everyS = Number(opt('every', 300));
const top = Number(opt('top', 25));
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
    power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: routing,
});

const stoppedSince = new Map();
function* everyCar() {
    for (const state of e.carriagewayState.values()) for (const lane of state.lanes) for (const car of lane.cars) yield car;
    for (const state of e.connectorState.values()) for (const k of ['fwd', 'rev']) for (const lane of state[k].lanes) for (const car of lane.cars) yield car;
    for (const car of e.turningCars) yield car;
}
function where(car) {
    const p = car.turnPath;
    if (p?.driveway) return `into driveway ${p.driveway.drivewayId ?? ''}`;
    if (p?.fromDriveway) return `out of driveway ${car.trip?.driveway?.drivewayId ?? ''}`;
    if (p?.ringNodeId) return `ring ${p.ringNodeId}`;
    if (p) return `turning -> ${e._roadName(car.road)} lane ${car.lane}`;
    return `${e._roadName(car.road)} lane ${car.lane} @${car.distanceM.toFixed(0)}m`;
}

const start = Date.now();
for (let tick = 0; tick < warm + duration; tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === duration / 4) e.setManualLoadShedding(true);
    if (outage && m === duration / 2) e.setManualLoadShedding(false);
    e.tick(dt);
    if (tick % 10) continue;
    const now = e.simTimeS;
    const live = new Set();
    for (const car of everyCar()) {
        live.add(car.id);
        if (car.speedMps < 0.1) { if (!stoppedSince.has(car.id)) stoppedSince.set(car.id, now); } else stoppedSince.delete(car.id);
    }
    for (const id of stoppedSince.keys()) if (!live.has(id)) stoppedSince.delete(id);

    if (m >= 0 && m % Math.round(everyS / dt) === 0) {
        const byRoad = new Map();
        const cars = [];
        for (const car of everyCar()) {
            const since = stoppedSince.get(car.id);
            if (since == null) continue;
            const key = car.turnPath ? where(car) : e._roadName(car.road);
            byRoad.set(key, (byRoad.get(key) ?? 0) + 1);
            cars.push({ car, stuckS: now - since });
        }
        const stuck = cars.filter((c) => c.stuckS > 120).length;
        console.log(`\n== measured ${(m * dt).toFixed(0)} s  power ${e.snapshot().powerState}  stopped ${cars.length}  stopped>120s ${stuck}  departuresWaiting ${(e.departures ?? []).reduce((s, d) => s + d.waiting.length, 0)}  (${((Date.now() - start) / 1000).toFixed(0)} s wall)`);
        console.log('   most stopped roads:', [...byRoad].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}=${n}`).join(' | '));
        if (stuck) for (const { car, stuckS } of cars.sort((a, b) => b.stuckS - a.stuckS).slice(0, top)) {
            console.log(`   car ${car.id} stopped ${stuckS.toFixed(0)} s  ${where(car)}  wait ${car.totalWaitS.toFixed(0)}  ${car.trip ? `trip -> ${car.trip.destId}` : ''}`);
        }
    }
}
const snap = e.snapshot();
const t = snap.total;
console.log(`\nmean wait ${(t.waitSumTotal / t.clearedTotal).toFixed(1)} s  throughput ${(t.clearedTotal / (duration * dt / 60)).toFixed(1)}/min  max ${e.waitDistributionTotal().maxWait.toFixed(0)} s  arrivalsLost ${e.accounting.arrivalsLost}`);
