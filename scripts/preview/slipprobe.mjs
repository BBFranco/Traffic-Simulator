// Runs a corridor headless and reports how its slip roads and Lunnon turn roads are used: node scripts/preview/slipprobe.mjs <config.json> [seconds] [mode]
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const seconds = Number(process.argv[3] ?? 900);
const mode = process.argv[4] ?? 'fixed';
const layout = buildLayout(config);
const engine = new SimulationEngine(layout);
const modes = {}, demand = {};
for (const a of layout.arterials) { modes[a.id] = mode; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand?.spawnRatePerLanePerMin ?? 0;
engine.reset({ seed: 5, arterialModes: modes, demand, sensorMode: 'camera', batteryBackedSensors: true, power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 } });

const watched = layout.connectors.filter((c) => c.id.startsWith('slip_') || c.id.startsWith('conn_dyer') || c.id.startsWith('conn_lunnon_') && c.id !== 'conn_lunnon_west').map((c) => c.id);
const seen = Object.fromEntries(watched.map((id) => [id, new Set()]));
const maxStopped = Object.fromEntries(watched.map((id) => [id, 0]));
for (let t = 0; t < seconds * 10; t += 1) {
    engine.tick(0.1);
    for (const id of watched) {
        const lanes = engine.connectorState.get(id).fwd.lanes;
        let stopped = 0;
        for (const lane of lanes) for (const car of lane.cars) { seen[id].add(car.id); if (car.speedMps < 0.3) stopped += 1; }
        maxStopped[id] = Math.max(maxStopped[id], stopped);
    }
}
for (const id of watched) console.log(id.padEnd(40), 'cars through:', String(seen[id].size).padStart(4), ' most stopped at once:', maxStopped[id]);
const acc = engine.carAccounting();
console.log('balanced:', acc.balanced, 'spawned', acc.totalSpawned, 'cleared', acc.totalClearedNetwork, 'on road', acc.onRoadNetwork);
