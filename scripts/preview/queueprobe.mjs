// Fixed-time (or other mode) run reporting mean wait and the approaches with the longest average queues.
// node scripts/preview/queueprobe.mjs <config.json> <mode> <warmS> <measureS> [--no-turns] [--seed N]
import { readFileSync } from 'node:fs';
import { buildLayout, compassDirection } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
const [path, mode = 'fixed', warmS = 1800, measureS = 1800] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(path, 'utf8'));
if (process.argv.includes('--no-turns')) for (const a of cfg.arterials) for (const n of a.intersections) delete n.turnPhases;
const seed = process.argv.includes('--seed') ? Number(process.argv[process.argv.indexOf('--seed') + 1]) : 1;
const layout = buildLayout(cfg);
const e = new SimulationEngine(layout);
const modes = {}, demand = {};
for (const a of layout.arterials) { modes[a.id] = mode; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand?.spawnRatePerLanePerMin ?? 0;
e.reset({ seed, arterialModes: modes, demand, sensorMode: 'inductive_loop', batteryBackedSensors: true, power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 } });
const gates = [...e.gatesByApproachId.values()];
const queue = new Map(gates.map((g) => [g, 0]));
let samples = 0;
const dt = 0.1;
for (let t = 0; t < (Number(warmS) + Number(measureS)) / dt; t++) {
    if (t === Math.round(Number(warmS) / dt)) e.resetStats();
    e.tick(dt);
    if (t < Number(warmS) / dt || t % 50) continue;
    samples++;
    for (const g of gates) {
        let n = 0;
        for (const lane of e._gateLanes(g)) for (const c of lane.cars) { const d = g.stopLineDistanceM - c.distanceM; if (d >= 0 && d < 400 && c.speedMps < 1) n++; }
        queue.set(g, queue.get(g) + n);
    }
}
const waits = e.allWaitTimesTotal;
const mean = waits.reduce((s, w) => s + w, 0) / waits.length;
const sorted = [...waits].sort((a, b) => a - b);
console.log(`${mode}${process.argv.includes('--no-turns') ? ' NO-TURNS' : ''} seed ${seed}: mean wait ${mean.toFixed(1)} s, median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)}, p95 ${sorted[Math.floor(sorted.length * 0.95)].toFixed(1)}, cleared ${waits.length}`);
const top = [...queue].map(([g, q]) => [`${g.node.id} ${compassDirection(g.approach.heading)}`, q / samples]).sort((a, b) => b[1] - a[1]).slice(0, 12);
for (const [k, q] of top) console.log('   ', k.padEnd(36), 'avg stopped', q.toFixed(1));
