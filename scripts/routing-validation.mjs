/**
 * routing-validation.mjs - Step 7 of the destination-routing plan: checks
 * that destination mode does what it claims, with driveways in.
 *
 *   node scripts\routing-validation.mjs shares [--draws=10000]
 *       Draws trips through the engine's own trip assignment and compares each
 *       origin's intended-destination shares with the OD table's. Flags any
 *       share more than 4 standard errors off.
 *
 *   node scripts\routing-validation.mjs crn [--seeds=1,2] [--ticks=6000]
 *       Common random numbers: for one seed, every one of the 12 conditions
 *       (controller x sensor x power) must hand each origin the same trips in
 *       the same order - same intended destination, route variant and driveway.
 *
 *   node scripts\routing-validation.mjs sensitivity [--seeds=1,2,3] [--warmup=24000]
 *                                       [--duration=36000] [--controllers=fixed,green_wave,adaptive]
 *       Tier sensitivity under normal power: the surveyed tiers, every block at
 *       tier 3 (attraction and driveway count both flat), and the surveyed tiers
 *       with 2 driveways a side (attraction alone). Prints wait, throughput,
 *       trip delay, missed driveways and diversion per controller, and each
 *       controller against fixed-time within every tier set.
 *
 * Common to all: [--corridor=hatfield-realistic].
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLayout } from '../resources/js/sim/corridor.js';
import { SimulationEngine } from '../resources/js/sim/engine.js';
import { buildExperimentalMatrix } from '../resources/js/sim/experimentalMatrix.js';
import { runHeadless } from '../resources/js/sim/runHeadless.js';

const [command, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.map((a) => a.replace(/^--/, '').split('=')));
const corridorId = args.corridor ?? 'hatfield-realistic';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'corridors', `${corridorId}.json`), 'utf8'));
const dt = 0.1;
/** Shares expected to draw fewer trips than this aren't z-tested - too rare for the normal approximation. */
const MIN_EXPECTED_DRAWS = 10;

function newEngine(corridorConfig, { seed, controllerMode = 'fixed', sensorMode = 'inductive_loop' }) {
    const layout = buildLayout(corridorConfig);
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
        batteryBackedSensors: true,
        power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 },
        routingMode: 'destination',
    });
    return engine;
}

function shares() {
    const draws = Number(args.draws ?? 10000);
    const engine = newEngine(config, { seed: 1 });
    const { od } = engine.routingModel;
    let worst = { z: 0 };
    let flagged = 0;
    let checked = 0;
    const rows = [];
    for (const origin of od.origins) {
        if (!origin.shares.length) continue;
        const counts = new Map();
        const car = {};
        for (let i = 0; i < draws; i += 1) {
            engine._assignTrip(car, origin.key);
            counts.set(car.trip.intendedDestId, (counts.get(car.trip.intendedDestId) ?? 0) + 1);
        }
        let exitShare = 0;
        let exitExpected = 0;
        for (const { destId, share, kind } of origin.shares) {
            const observed = (counts.get(destId) ?? 0) / draws;
            if (kind === 'exit') {
                exitShare += observed;
                exitExpected += share;
            }
            // The normal approximation behind the z-score needs a handful of expected draws; rarer pairs are only summed.
            if (share * draws < MIN_EXPECTED_DRAWS) continue;
            const se = Math.sqrt(Math.max(share * (1 - share), 1e-12) / draws);
            const z = (observed - share) / se;
            checked += 1;
            if (Math.abs(z) > 4) flagged += 1;
            if (Math.abs(z) > Math.abs(worst.z)) worst = { z, origin: origin.key, destId, share, observed };
        }
        rows.push({ origin: origin.key, destinations: origin.shares.length, exitExpected: +exitExpected.toFixed(3), exitObserved: +exitShare.toFixed(3) });
    }
    console.table(rows);
    console.log(`${checked} origin-destination shares (expected >= ${MIN_EXPECTED_DRAWS} draws) checked over ${draws} draws per origin; ${flagged} more than 4 standard errors off.`);
    console.log(`Largest deviation: ${worst.origin} -> ${worst.destId}: expected ${(worst.share * 100).toFixed(2)}%, drew ${(worst.observed * 100).toFixed(2)}% (z = ${worst.z.toFixed(2)}).`);
    return flagged === 0;
}

/** Every trip handed out, per origin road, in spawn order. */
function recordTrips(engine) {
    const byOrigin = new Map();
    const assign = engine._assignTrip.bind(engine);
    engine._assignTrip = (car, roadKey) => {
        assign(car, roadKey);
        if (!car.trip) return;
        if (!byOrigin.has(roadKey)) byOrigin.set(roadKey, []);
        byOrigin.get(roadKey).push(`${car.trip.intendedDestId}|${car.trip.variant}|${car.trip.driveway?.drivewayId ?? '-'}`);
    };
    return byOrigin;
}

function crn() {
    const seeds = (args.seeds ?? '1,2').split(',').map(Number);
    const ticks = Number(args.ticks ?? 6000);
    let allMatch = true;
    for (const seed of seeds) {
        const runs = buildExperimentalMatrix().map((condition) => {
            const engine = newEngine(config, { seed, controllerMode: condition.controllerMode, sensorMode: condition.sensorMode });
            const trips = recordTrips(engine);
            for (let tick = 0; tick < ticks; tick += 1) {
                if (condition.powerState === 'load_shedding' && tick === Math.round(ticks / 4)) engine.setManualLoadShedding(true);
                if (condition.powerState === 'load_shedding' && tick === Math.round(ticks / 2)) engine.setManualLoadShedding(false);
                engine.tick(dt);
            }
            return { key: condition.key, trips };
        });
        // Each pair of conditions must agree on every origin's trips for as many as both spawned.
        const [reference, ...others] = runs;
        const rows = others.map(({ key, trips }) => {
            let compared = 0;
            let mismatched = 0;
            for (const [origin, sequence] of reference.trips) {
                const other = trips.get(origin) ?? [];
                const n = Math.min(sequence.length, other.length);
                compared += n;
                for (let i = 0; i < n; i += 1) if (sequence[i] !== other[i]) mismatched += 1;
            }
            if (mismatched) allMatch = false;
            return { seed, against: reference.key, condition: key, tripsCompared: compared, mismatched };
        });
        console.table(rows);
    }
    console.log(allMatch ? 'Common random numbers hold: every condition hands out the same trips per origin.' : 'MISMATCH: trips differ between conditions for the same seed.');
    return allMatch;
}

function tierVariant(name) {
    const variant = structuredClone(config);
    if (name === 'flat3') for (const block of variant.routing.blocks) block.tier = 3;
    if (name === 'fixed2') variant.routing.drivewaysPerSide = 2;
    return variant;
}

function sensitivity() {
    const seeds = (args.seeds ?? '1,2,3').split(',').map(Number);
    const warmupTicks = Number(args.warmup ?? 24000);
    const durationTicks = Number(args.duration ?? 36000);
    const controllers = (args.controllers ?? 'fixed,green_wave,adaptive').split(',');
    const variants = [
        ['surveyed', 'Surveyed tiers (driveways 1/2/3 by tier)'],
        ['flat3', 'Every block tier 3 (2 driveways a side)'],
        ['fixed2', 'Surveyed tiers, 2 driveways a side'],
    ];
    const results = [];
    for (const [name] of variants) {
        const corridorConfig = tierVariant(name);
        for (const controllerMode of controllers) {
            for (const seed of seeds) {
                const started = Date.now();
                const { summary } = runHeadless({ seed, controllerMode, sensorMode: 'inductive_loop', warmupTicks, corridorConfig, durationTicks, dt, sampleEverySeconds: 60, routingMode: 'destination' });
                const r = summary.routing;
                results.push({
                    variant: name,
                    controllerMode,
                    seed,
                    wait: summary.avgWaitTime,
                    throughput: summary.throughputPerMin,
                    tripDelay: r.meanTripDelayS,
                    missedDrivewaysPct: r.pulledOff ? (r.missedDriveways / r.pulledOff) * 100 : null,
                    divertedPct: r.divertedPct,
                });
                console.error(`${name} ${controllerMode} seed ${seed}: ${((Date.now() - started) / 1000).toFixed(0)} s`);
            }
        }
    }

    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const table = [];
    for (const [name, label] of variants) {
        for (const controllerMode of controllers) {
            const rows = results.filter((r) => r.variant === name && r.controllerMode === controllerMode);
            const fixedRows = results.filter((r) => r.variant === name && r.controllerMode === 'fixed');
            // Paired by seed against fixed-time in the same tier set.
            const deltas = rows.map((r) => {
                const base = fixedRows.find((f) => f.seed === r.seed);
                return base ? ((r.wait - base.wait) / base.wait) * 100 : null;
            });
            table.push({
                tiers: label,
                controller: controllerMode,
                waitS: +mean(rows.map((r) => r.wait)).toFixed(1),
                waitVsFixedPct: controllerMode === 'fixed' || deltas.includes(null) ? null : +mean(deltas).toFixed(1),
                throughput: +mean(rows.map((r) => r.throughput)).toFixed(1),
                tripDelayS: +mean(rows.map((r) => r.tripDelay)).toFixed(1),
                missedDrivewaysPct: +mean(rows.map((r) => r.missedDrivewaysPct)).toFixed(1),
                divertedPct: +mean(rows.map((r) => r.divertedPct)).toFixed(1),
            });
        }
    }
    console.table(table);
    return true;
}

const commands = { shares, crn, sensitivity };
if (!commands[command]) {
    console.error('Usage: node scripts/routing-validation.mjs shares|crn|sensitivity [options] - see the header comment.');
    process.exit(2);
}
process.exit(commands[command]() ? 0 : 1);
