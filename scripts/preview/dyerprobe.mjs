import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
const layout = buildLayout(JSON.parse(readFileSync(process.argv[2], 'utf8')));
const engine = new SimulationEngine(layout);
const modes = {}, demand = {};
for (const a of layout.arterials) { modes[a.id] = 'fixed'; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand?.spawnRatePerLanePerMin ?? 0;
engine.reset({ seed: 9, arterialModes: modes, demand, sensorMode: 'camera', batteryBackedSensors: true, power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 } });
const info = engine.nodesInfo.get('lunnon_dyer');
console.log('lunnon_dyer control', info.controllerType, 'cross gates', info.crossGates.length, 'arterial gates', info.arterialGates.length);
const seen = new Set(), stopT = new Map(), lastSeen = new Map(), waits = [];
for (let t = 0; t < 9000; t++) {
    engine.tick(0.1);
    const present = new Set();
    for (const lane of engine.connectorState.get('conn_dyer').fwd.lanes) for (const car of lane.cars) {
        present.add(car.id); seen.add(car.id);
        if (car.speedMps < 0.2 && !stopT.has(car.id)) stopT.set(car.id, engine.simTimeS);
    }
    // a car that was in the lane last tick and is gone now has been let go (turned onto Lunnon)
    for (const id of lastSeen.keys()) if (!present.has(id) && stopT.has(id)) { waits.push(engine.simTimeS - stopT.get(id)); stopT.delete(id); }
    lastSeen.clear(); for (const id of present) lastSeen.set(id, 1);
}
waits.sort((a, b) => a - b);
console.log('northbound Dyer cars reaching Lunnon:', seen.size, ' that stopped, then turned:', waits.length, ' median stop', waits[Math.floor(waits.length / 2)]?.toFixed(1), 's, longest', waits.at(-1)?.toFixed(1), 's');
console.log(engine.carAccounting());
