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

/** `rolling: true`: a rolling blackout inside the default 600 s hash run - zones 1+3 dark 100-300 s, zone 2 300-500 s. */
export const HASH_ROLLING_WINDOWS = [
    { zones: [1, 3], fromS: 100, toS: 300 },
    { zones: [2], fromS: 300, toS: 500 },
];

/**
 * Builds and resets an engine the same way fingerprint.mjs always has.
 */
export function startEngine({ config, seed, controllerMode, loadShedding = false, rolling = false, routingMode = null, sensorMode = 'inductive_loop', sensorSpecSet = undefined, demandMultiplier = 1 }) {
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
        sensorMode,
        sensorSpecSet,
        batteryBackedSensors: true,
        power: { loadShedding, scheduledOutages: false, offMinutes: 2, periodMinutes: 8, ...(rolling ? { zoneSchedule: HASH_ROLLING_WINDOWS } : {}) },
        routingMode,
    });
    engine.demandMultiplier = demandMultiplier;
    return { layout, engine };
}

/**
 * Runs `ticks` ticks and returns the 16-hex trajectory hash. `onTick(engine, tick, cars)` lets
 * callers observe each tick (fingerprint.mjs's stuck-car check, the live-metrics collector).
 */
export function hashRun({ config, seed, controllerMode, loadShedding = false, rolling = false, routingMode = null, sensorMode = 'inductive_loop', sensorSpecSet = undefined, demandMultiplier = 1, ticks = 6000, dt = 0.1, onStart = null, onTick = null }) {
    const { layout, engine } = startEngine({ config, seed, controllerMode, loadShedding, rolling, routingMode, sensorMode, sensorSpecSet, demandMultiplier });
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
