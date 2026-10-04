/**
 * fingerprint.mjs - legacy-mode regression check, and a quick destination-mode health check.
 *
 * Runs the engine headless for a few seeds x controllers and hashes every
 * car's id, lane, position and speed on every tick. Two code versions that
 * print the same trajectory hash moved every car identically; the metric
 * columns alongside show what a stats-only change did to the numbers.
 *
 *   node batch\fingerprint.mjs [--corridor=hatfield-realistic] [--ticks=6000] [--seeds=1,2,3]
 *                              [--routing=random|destination] [--controllers=fixed,green_wave,adaptive]
 *
 * With --routing=destination it also reports the trips (pulled off / out of
 * the map / diverted), missed turns and reroutes, and the longest any one car
 * sat stopped - a deadlock shows up there as a stop as long as the run.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLayout } from '../resources/js/sim/corridor.js';
import { SimulationEngine } from '../resources/js/sim/engine.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const corridorId = args.corridor ?? 'hatfield-realistic';
const ticks = Number(args.ticks ?? 6000);
const seeds = (args.seeds ?? '1,2,3').split(',').map(Number);
const controllers = (args.controllers ?? 'fixed,green_wave,adaptive').split(',');
const routingMode = args.routing ?? null;
const dt = 0.1;
/** How often (ticks) the stuck-car check looks at every car. */
const STUCK_SAMPLE_TICKS = 10;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'corridors', `${corridorId}.json`), 'utf8'));

function everyCar(engine) {
    const cars = [];
    for (const state of engine.carriagewayState.values()) for (const lane of state.lanes) cars.push(...lane.cars);
    for (const state of engine.connectorState.values()) {
        for (const dirKey of ['fwd', 'rev']) for (const lane of state[dirKey].lanes) cars.push(...lane.cars);
    }
    cars.push(...engine.turningCars);
    return cars;
}

function run(seed, controllerMode) {
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
        power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 },
        routingMode,
    });

    const hash = createHash('sha1');
    const stoppedSince = new Map();
    let longestStop = { s: 0 };
    for (let tick = 0; tick < ticks; tick += 1) {
        engine.tick(dt);
        const cars = everyCar(engine);
        for (const car of cars) hash.update(`${car.id}|${car.lane}|${car.distanceM.toFixed(6)}|${car.speedMps.toFixed(6)};`);
        if (routingMode === 'destination' && tick % STUCK_SAMPLE_TICKS === 0) {
            const seen = new Set();
            for (const car of cars) {
                if (!car.stoppedNow) continue;
                seen.add(car.id);
                if (!stoppedSince.has(car.id)) stoppedSince.set(car.id, engine.simTimeS);
                const s = engine.simTimeS - stoppedSince.get(car.id);
                if (s > longestStop.s) longestStop = { s, where: `${car.trip?.origin ?? '?'} -> ${car.trip?.destId ?? '?'}` };
            }
            for (const id of [...stoppedSince.keys()]) if (!seen.has(id)) stoppedSince.delete(id);
        }
    }

    const snap = engine.snapshot();
    let cleared = 0;
    let waitSum = 0;
    let noStop = 0;
    for (const s of [...layout.arterials.map((a) => snap.stats[a.id]), snap.sideStreet, snap.arterialConnectors].filter(Boolean)) {
        cleared += s.clearedTotal;
        waitSum += s.waitSumTotal;
        noStop += s.clearedWithoutStopTotal;
    }
    const accounting = engine.carAccounting();
    const row = {
        seed,
        controllerMode,
        trajectory: hash.digest('hex').slice(0, 16),
        spawned: accounting.totalSpawned,
        balanced: accounting.balanced,
        cleared,
        avgWaitS: cleared ? +(waitSum / cleared).toFixed(3) : null,
        noStopPct: cleared ? +((noStop / cleared) * 100).toFixed(2) : null,
    };
    if (routingMode === 'destination') {
        const r = engine.routingStats;
        Object.assign(row, {
            pulledOff: r.pulledOff,
            toExit: r.toExit,
            divertedPct: r.trips ? +((r.diverted / r.trips) * 100).toFixed(1) : null,
            missedTurns: r.missedTurns,
            rerouted: r.rerouted,
            meanTripS: r.trips ? +(r.tripTimeSumS / r.trips).toFixed(1) : null,
            longestStopS: Math.round(longestStop.s),
        });
        if (longestStop.s > 300) console.log(`seed ${seed} ${controllerMode}: a car sat stopped ${Math.round(longestStop.s)} s (${longestStop.where})`);
    }
    return row;
}

const results = [];
for (const seed of seeds) for (const controllerMode of controllers) results.push(run(seed, controllerMode));
console.table(results);
