// Per seed, batch-shaped run (60 min warm-up + 60 min measured): missed turns against stopped cars on Jan Shoba and
// against the seed's demand, to tell "queues stop cars reaching their lane" apart from plain demand variation.
// node scripts/preview/missedprobe.mjs <config.json> <controller> <sensor> <seed,seed,...>
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seeds] = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(path, 'utf8'));
const dt = 0.1;
const warm = 36000;
const duration = 36000;

for (const seed of seeds.split(',').map(Number)) {
    const layout = buildLayout(cfg);
    const e = new SimulationEngine(layout);
    const modes = {};
    const demand = {};
    for (const a of layout.arterials) { modes[a.id] = controller; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
    for (const c of layout.connectors) demand[c.id] = c.demand.spawnRatePerLanePerMin;
    e.reset({
        seed, arterialModes: modes, demand, sensorMode: sensor, batteryBackedSensors: true,
        power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: 'destination',
    });
    let spawnedAtStart = 0;
    let janShobaStopped = 0;
    let allStopped = 0;
    let samples = 0;
    for (let tick = 0; tick < warm + duration; tick += 1) {
        if (tick === warm) { e.resetStats(); spawnedAtStart = e.accounting.totalSpawned; }
        e.tick(dt);
        if (tick < warm || tick % 100) continue;
        samples += 1;
        const count = (car) => {
            if (car.speedMps >= 0.1) return;
            allStopped += 1;
            if (!car.turnPath && e._roadName(car.road).startsWith('Jan Shoba')) janShobaStopped += 1;
        };
        for (const state of e.carriagewayState.values()) for (const lane of state.lanes) lane.cars.forEach(count);
        for (const state of e.connectorState.values()) for (const k of ['fwd', 'rev']) for (const lane of state[k].lanes) lane.cars.forEach(count);
        e.turningCars.forEach(count);
    }
    const s = e.routingStats;
    const missedJanShoba = Object.entries(s.missedAt ?? {}).filter(([k]) => /janshoba|jan_shoba/i.test(k)).reduce((n, [, v]) => n + v, 0);
    const t = e.totalStats;
    console.log(JSON.stringify({
        seed, wait: +(t.waitSumTotal / t.clearedTotal).toFixed(1), missedTurns: s.missedTurns ?? Object.values(s.missedAt ?? {}).reduce((a, b) => a + b, 0),
        missedJanShoba, janShobaStopped: +(janShobaStopped / samples).toFixed(1), allStopped: +(allStopped / samples).toFixed(1),
        spawned: e.accounting.totalSpawned - spawnedAtStart,
    }));
}
