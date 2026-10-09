/**
 * trajectoryHash.mjs - the dynamics fingerprint shared by batch/fingerprint.mjs and the
 * trajectory-hash regression test.
 *
 * Hashes every car's id, lane, position and speed on every tick. Two code versions that
 * return the same hash moved every car identically.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLayout } from '../resources/js/sim/corridor.js';
import { SimulationEngine } from '../resources/js/sim/engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadCorridor(corridorId) {
    return JSON.parse(fs.readFileSync(path.join(root, 'corridors', `${corridorId}.json`), 'utf8'));
}

export function everyCar(engine) {
    const cars = [];
    for (const state of engine.carriagewayState.values()) for (const lane of state.lanes) cars.push(...lane.cars);
    for (const state of engine.connectorState.values()) {
        for (const dirKey of ['fwd', 'rev']) for (const lane of state[dirKey].lanes) cars.push(...lane.cars);
    }
    cars.push(...engine.turningCars);
    return cars;
}

/**
 * Builds and resets an engine the same way fingerprint.mjs always has.
 */
export function startEngine({ config, seed, controllerMode, loadShedding = false, routingMode = null }) {
    const layout = buildLayout(config);
    const engine = new SimulationEngine(layout);
    const arterialModes = {};
    const demand = {};
    for (const arterial of layout.arterials) {
        arterialModes[arterial.id] = controllerMode;
        demand[arterial.id] = arterial.demand.spawnRatePerLanePerMin;
    }
    for (const connector of layout.connectors) demand[connector.id] = connector.demand.spawnRatePerLanePerMin;
    engine.reset({
        seed,
        arterialModes,
        demand,
        sensorMode: 'inductive_loop',
        batteryBackedSensors: true,
        power: { loadShedding, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 },
        routingMode,
    });
    return { layout, engine };
}

/**
 * Runs `ticks` ticks and returns the 16-hex trajectory hash. `onTick(engine, tick, cars)` lets
 * callers observe each tick (fingerprint.mjs's stuck-car check, the live-metrics collector).
 */
export function hashRun({ config, seed, controllerMode, loadShedding = false, routingMode = null, ticks = 6000, dt = 0.1, onStart = null, onTick = null }) {
    const { layout, engine } = startEngine({ config, seed, controllerMode, loadShedding, routingMode });
    onStart?.(engine, layout);
    const hash = createHash('sha1');
    for (let tick = 0; tick < ticks; tick += 1) {
        engine.tick(dt);
        const cars = everyCar(engine);
        for (const car of cars) hash.update(`${car.id}|${car.lane}|${car.distanceM.toFixed(6)}|${car.speedMps.toFixed(6)};`);
        onTick?.(engine, tick, cars);
    }
    return { layout, engine, trajectory: hash.digest('hex').slice(0, 16) };
}
