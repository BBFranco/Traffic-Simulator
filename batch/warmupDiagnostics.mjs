#!/usr/bin/env node
/**
 * batch/warmupDiagnostics.mjs - measures how many ticks each scope
 * (Total/Arterial/Side-Streets) actually needs to reach a steady state under
 * normal power, instead of asserting a single fixed WARMUP_TICKS is "long
 * enough" for all three (see runBatch.mjs's `--warmup-ticks` doc and
 * results.js's WARMUP_TICKS - both currently just 3600, unverified per
 * scope).
 *
 * Why this matters: the engine resets its stats accumulators once, at the
 * end of the shared warm-up window (engine.js's resetStats()), before the
 * pre-outage baseline starts measuring. If arterial-only traffic takes
 * longer than 3600 ticks to leave its from-empty ramp-up transient, an
 * "Adaptive's arterial pre-outage baseline is worse" reading downstream
 * could just be measuring an incompletely-settled arterial, not a real
 * baseline difference - this script is how to tell those apart.
 *
 * Runs a single long normal-power condition with warmupTicks: 0 (so
 * sampling starts at tick 0 and the ramp-up itself is visible), then applies
 * detectPlateau() to each scope's per-tick weighted average wait, reusing
 * the exact same scoped-aggregation helpers buildSummary() uses internally.
 *
 * Usage:
 *   node batch/warmupDiagnostics.mjs [--corridor=hatfield-pretorius-francisbaard]
 *     [--controller-mode=adaptive] [--sensor-mode=inductive_loop]
 *     [--duration=20000] [--seed=20260101] [--dt=0.1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHeadless, buildByTickWeightedAvgWait, buildByTickThroughput } from '../resources/js/sim/runHeadless.js';
import { detectPlateau } from '../resources/js/sim/plateau.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** Current shared constant this diagnostic is checking - see results.js:WARMUP_TICKS and runBatch.mjs's --warmup-ticks default. */
const CURRENT_WARMUP_TICKS = 3600;

/** Multiplier applied to the slowest scope's measured convergence tick before recommending a new warm-up length - a safety margin, not a measured quantity itself. */
const SAFETY_MARGIN = 1.5;

function parseArgs(argv) {
    const args = {
        corridor: 'hatfield-pretorius-francisbaard',
        controllerMode: 'adaptive',
        sensorMode: 'inductive_loop',
        duration: 20000,
        seed: 20260101,
        dt: 0.1,
    };
    for (const arg of argv) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'corridor') args.corridor = value;
        else if (key === 'controller-mode') args.controllerMode = value;
        else if (key === 'sensor-mode') args.sensorMode = value;
        else if (key === 'duration') args.duration = Number(value);
        else if (key === 'seed') args.seed = Number(value);
        else if (key === 'dt') args.dt = Number(value);
    }
    return args;
}

function toSamples(byTick) {
    return [...byTick.entries()].map(([tick, value]) => ({ tick, value }));
}

function reportScope(label, byTick, dt) {
    const { convergedAtTick, windowMeans } = detectPlateau(toSamples(byTick), { dt });
    if (convergedAtTick == null) {
        console.log(`  ${label}: never stabilized within the ${windowMeans.length} sampled windows.`);
        return null;
    }
    const seconds = convergedAtTick * dt;
    console.log(`  ${label}: converged at tick ${convergedAtTick} (${seconds.toFixed(0)}s).`);
    return convergedAtTick;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const corridorPath = path.join(ROOT, 'corridors', `${args.corridor}.json`);
    const corridorConfig = JSON.parse(fs.readFileSync(corridorPath, 'utf8'));

    console.log(`Running a ${args.duration}-tick normal-power ${args.controllerMode} run against "${args.corridor}" (warmupTicks: 0, seed ${args.seed})...`);
    const { rows, sideStreetRows } = runHeadless({
        seed: args.seed,
        controllerMode: args.controllerMode,
        sensorMode: args.sensorMode,
        warmupTicks: 0,
        powerOutageStartTick: null,
        powerOutageEndTick: null,
        corridorConfig,
        durationTicks: args.duration,
        dt: args.dt,
    });

    const arterialWaitByTick = buildByTickWeightedAvgWait([rows]);
    const sideStreetWaitByTick = buildByTickWeightedAvgWait([sideStreetRows]);
    const totalWaitByTick = buildByTickWeightedAvgWait([rows, sideStreetRows]);

    console.log('\nAverage-wait convergence per scope:');
    const waitConvergence = {
        total: reportScope('Total', totalWaitByTick, args.dt),
        arterial: reportScope('Arterial', arterialWaitByTick, args.dt),
        sideStreet: reportScope('Side-Streets', sideStreetWaitByTick, args.dt),
    };

    const arterialThroughputByTick = buildByTickThroughput(rows);
    const sideStreetThroughputByTick = buildByTickThroughput(sideStreetRows);
    console.log('\nThroughput convergence per scope:');
    reportScope('Arterial', arterialThroughputByTick, args.dt);
    reportScope('Side-Streets', sideStreetThroughputByTick, args.dt);

    const measuredTicks = Object.values(waitConvergence).filter((t) => t != null);
    const unstableScopes = Object.entries(waitConvergence).filter(([, t]) => t == null).map(([scope]) => scope);
    if (unstableScopes.length) {
        console.log(
            `\nNote: ${unstableScopes.join(', ')} never satisfied the convergence test on this seed - ` +
                `treat this run as inconclusive for ${unstableScopes.length > 1 ? 'those scopes' : 'that scope'} and re-run with a different --seed before drawing a conclusion.`
        );
    }
    console.log(`\nCurrent shared warm-up: ${CURRENT_WARMUP_TICKS} ticks (${(CURRENT_WARMUP_TICKS * args.dt).toFixed(0)}s).`);
    if (!measuredTicks.length) {
        console.log('No scope stabilized within the run - lengthen --duration and re-run before trusting the current constant.');
        return;
    }
    const slowest = Math.max(...measuredTicks);
    const recommended = Math.ceil((slowest * SAFETY_MARGIN) / 100) * 100;
    console.log(`Slowest-converging scope needs ~${slowest} ticks; with a x${SAFETY_MARGIN} safety margin that's ~${recommended} ticks.`);
    // The verdict is against the raw MEASURED tick, not the margined `recommended` figure - the
    // margin is a cushion suggestion, not itself evidence the current constant is insufficient.
    console.log(
        slowest > CURRENT_WARMUP_TICKS
            ? `=> Current warm-up is TOO SHORT for at least one scope (measured convergence exceeds it) - update WARMUP_TICKS (results.js) and --warmup-ticks's default (runBatch.mjs), e.g. to ~${recommended}.`
            : `=> Current warm-up already covers every scope's measured convergence point (${slowest} <= ${CURRENT_WARMUP_TICKS} ticks) - no change needed, though bumping toward ~${recommended} would add cushion.`
    );
}

main();
