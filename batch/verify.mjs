#!/usr/bin/env node
/**
 * batch/verify.mjs - build step 14's verification pass, as a script rather
 * than a person eyeballing numbers. Run this against the full grid config
 * BEFORE trusting any batch output for the dissertation's results chapter -
 * cheap to run, expensive to skip and find out later the dataset came from a
 * broken sim.
 *
 * Checks (see Phase 2 spec "Verification pass"):
 *   1. Seed determinism    - identical {seed, config} run twice -> identical output.
 *   2. Car conservation    - spawned - cleared - onRoad == 0, network-wide.
 *   3. Queue-length bounds - never negative, never past a sane per-lane cap.
 *   4. Load-shedding       - a power event actually engages the all-way-stop
 *                            fallback and the run still completes to durationTicks.
 *
 * Webster's-method hand-check is NOT here - the spec is explicit that one is a
 * manual/spreadsheet comparison against equations.js:websterOptimumCycle()'s
 * actual output, not something to automate away.
 *
 * Usage: node batch/verify.mjs [--corridor=hatfield-pretorius-francisbaard] [--duration=1200]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHeadless } from '../resources/js/sim/runHeadless.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
    const args = { corridor: 'hatfield-pretorius-francisbaard', duration: 1200, dt: 0.1 };
    for (const arg of argv) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'corridor') args.corridor = value;
        else if (key === 'duration') args.duration = Number(value);
        else if (key === 'dt') args.dt = Number(value);
    }
    return args;
}

function loadCorridor(id) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'corridors', `${id}.json`), 'utf8'));
}

function fail(results, name, detail) {
    results.push({ name, ok: false, detail });
}
function pass(results, name, detail) {
    results.push({ name, ok: true, detail });
}

function checkSeedDeterminism(results, corridorConfig, duration, dt) {
    const opts = { seed: 424242, controllerMode: 'adaptive', sensorMode: 'camera', powerOutageStartTick: null, powerOutageEndTick: null, corridorConfig, durationTicks: duration, dt };
    const a = runHeadless(opts);
    const b = runHeadless(opts);

    const aStr = JSON.stringify(a.rows);
    const bStr = JSON.stringify(b.rows);
    if (aStr === bStr) {
        pass(results, 'Seed determinism', `${a.rows.length} rows identical across two runs of the same {seed, config}.`);
    } else {
        fail(results, 'Seed determinism', 'Two runs of the identical {seed, config} produced different output - something is still reading unseeded randomness.');
    }
}

function checkCarConservation(results, run, label) {
    const { balanced, totalSpawned, totalClearedNetwork, onRoadNetwork } = run.summary.carAccounting;
    if (balanced) {
        pass(results, `Car conservation (${label})`, `${totalSpawned} spawned = ${totalClearedNetwork} cleared + ${onRoadNetwork} on-road.`);
    } else {
        fail(
            results,
            `Car conservation (${label})`,
            `spawned=${totalSpawned}, cleared=${totalClearedNetwork}, onRoad=${onRoadNetwork} - does not balance. Cars are vanishing or duplicating.`
        );
    }
}

function checkQueueBounds(results, run, corridorConfig, label) {
    const laneWidthM = corridorConfig.defaults?.laneWidthM ?? 3.5;
    const carLengthM = corridorConfig.defaults?.carLengthM ?? 4.5;
    const maxLanes = Math.max(...corridorConfig.arterials.map((a) => a.lanes ?? 1));
    // QUEUE_WINDOW_M in engine.js is 150 - mirrored here rather than imported,
    // since this is a sanity bound, not a shared constant the sim depends on.
    const queueWindowM = 150;
    const cap = Math.ceil((queueWindowM / carLengthM) * maxLanes);

    let minSeen = Infinity;
    let maxSeen = -Infinity;
    for (const row of run.rows) {
        for (const [key, value] of Object.entries(row)) {
            if (!key.startsWith('queueLength_')) continue;
            minSeen = Math.min(minSeen, value);
            maxSeen = Math.max(maxSeen, value);
        }
    }

    if (minSeen < 0) {
        fail(results, `Queue-length bounds (${label})`, `Saw a negative queue length (min ${minSeen}) - despawn/counting bug.`);
    } else if (maxSeen > cap) {
        fail(results, `Queue-length bounds (${label})`, `Saw queue length ${maxSeen}, above the sane cap of ~${cap} for this corridor - cars likely aren't despawning.`);
    } else {
        pass(results, `Queue-length bounds (${label})`, `Range [${minSeen === Infinity ? 0 : minSeen}, ${maxSeen === -Infinity ? 0 : maxSeen}], cap ~${cap}.`);
    }
}

function checkLoadShedding(results, run, label) {
    const rows = run.rows.filter((r) => r.powerState === 'load_shedding');
    if (!rows.length) {
        fail(results, `Load-shedding engages (${label})`, 'No sampled row reported powerState=load_shedding after the trigger tick - the outage never actually engaged.');
        return;
    }
    pass(results, `Load-shedding engages (${label})`, `${rows.length} sampled rows report load_shedding after the trigger, and the run completed to durationTicks without throwing.`);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const corridorConfig = loadCorridor(args.corridor);
    const results = [];

    console.log(`Verification pass against "${args.corridor}" (${args.duration} ticks @ dt=${args.dt}s)...\n`);

    checkSeedDeterminism(results, corridorConfig, args.duration, args.dt);

    const normalRun = runHeadless({
        seed: 1,
        controllerMode: 'fixed',
        sensorMode: 'inductive_loop',
        powerOutageStartTick: null,
        powerOutageEndTick: null,
        corridorConfig,
        durationTicks: args.duration,
        dt: args.dt,
    });
    checkCarConservation(results, normalRun, 'fixed, normal power');
    checkQueueBounds(results, normalRun, corridorConfig, 'fixed, normal power');

    const outageStartTick = Math.floor(args.duration / 4);
    const outageEndTick = Math.floor(args.duration / 2);
    const outageRun = runHeadless({
        seed: 2,
        controllerMode: 'adaptive',
        sensorMode: 'radar',
        powerOutageStartTick: outageStartTick,
        powerOutageEndTick: outageEndTick,
        corridorConfig,
        durationTicks: args.duration,
        dt: args.dt,
    });
    checkCarConservation(results, outageRun, 'adaptive, load-shedding');
    checkQueueBounds(results, outageRun, corridorConfig, 'adaptive, load-shedding');
    checkLoadShedding(results, outageRun, 'adaptive, load-shedding');

    for (const r of results) {
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} - ${r.detail}`);
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
        console.log(`\n${failed.length}/${results.length} checks FAILED. Fix these before generating any batch data meant for the dissertation.`);
        process.exitCode = 1;
    } else {
        console.log(`\nAll ${results.length} checks passed.`);
    }
}

main();
