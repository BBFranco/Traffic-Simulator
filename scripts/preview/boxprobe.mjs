// Counts right-turners that wait in the junction for a gap, how long they wait, and checks the run still balances.
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
const layout = buildLayout(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const mode = process.argv[3] ?? 'fixed';
const e = new SimulationEngine(layout);
const modes = {}, demand = {};
for (const a of layout.arterials) { modes[a.id] = mode; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand?.spawnRatePerLanePerMin ?? 0;
e.reset({ seed: 3, arterialModes: modes, demand, sensorMode: 'inductive_loop', batteryBackedSensors: true, power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 } });
const waiting = new Map(), done = [], byNode = {};
let maxPerGate = 0;
for (let t = 0; t < 12000; t++) {
    e.tick(0.1);
    const perGate = new Map();
    const now = new Set();
    for (const c of e.turningCars) {
        const w = c.turnPath?.boxWait;
        if (!w) continue;
        now.add(c.id);
        if (!waiting.has(c.id)) { waiting.set(c.id, e.simTimeS); byNode[w.gate.node.id] = (byNode[w.gate.node.id] ?? 0) + 1; }
        perGate.set(w.gate, (perGate.get(w.gate) ?? 0) + 1);
    }
    for (const n of perGate.values()) maxPerGate = Math.max(maxPerGate, n);
    for (const [id, since] of waiting) if (!now.has(id)) { done.push(e.simTimeS - since); waiting.delete(id); }
}
done.sort((a, b) => a - b);
console.log(`${mode}: ${done.length} right-turners waited in the box (20 min), median ${done[Math.floor(done.length / 2)]?.toFixed(1)} s, longest ${done.at(-1)?.toFixed(1)} s, most at once per approach ${maxPerGate}`);
console.log('busiest junctions:', Object.entries(byNode).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', '));
console.log('balanced:', e.carAccounting().balanced);
