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
 *     [--duration=20000] [--seed=20260101] [--dt=0.1] [--windows]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHeadless, buildByTickWeightedAvgWait, buildByTickThroughput } from '../resources/js/sim/runHeadless.js';
import { detectPlateau } from '../resources/js/sim/plateau.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** The old shared warm-up constant, kept as the reference this diagnostic reports against (batches now measure their own - sim/warmupProbe.js). */
const CURRENT_WARMUP_TICKS = 3600;
/** Drift is judged over one batch run's measured window (runBatch.mjs's --duration default, 24000 ticks at dt 0.1), as the probe does. */
const MEASURED_HORIZON_S = 2400;

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
        windows: false,
    };
    for (const arg of argv) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'corridor') args.corridor = value;
        else if (key === 'controller-mode') args.controllerMode = value;
        else if (key === 'sensor-mode') args.sensorMode = value;
        else if (key === 'duration') args.duration = Number(value);
        else if (key === 'seed') args.seed = Number(value);
        else if (key === 'dt') args.dt = Number(value);
        else if (key === 'windows') args.windows = true;
    }
    return args;
}

function toSamples(byTick) {
    return [...byTick.entries()].map(([tick, value]) => ({ tick, value }));
}

function reportScope(label, byTick, dt, printWindows = false) {
    const { convergedAtTick, truncationTick, driftRatio, windowMeans } = detectPlateau(toSamples(byTick), { dt, horizonSeconds: MEASURED_HORIZON_S });
    // Raw window means, so a "converged"/"never stabilized" verdict can be checked by eye - the
    // detector has been wrong before (see plateau.js's doc on the early/late-half version it replaced).
    if (printWindows) console.log(`  ${label} window means: ${windowMeans.map((w) => `${(w.tick * dt).toFixed(0)}s=${w.mean.toFixed(1)}`).join(' ')}`);
    if (convergedAtTick == null) {
        const cut = truncationTick == null ? 'too few windows to test' : `still trending after the best cut at ${(truncationTick * dt).toFixed(0)}s (drift ${(driftRatio * 100).toFixed(0)}%)`;
        console.log(`  ${label}: never stabilized - ${cut}.`);
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
        total: reportScope('Total', totalWaitByTick, args.dt, args.windows),
        arterial: reportScope('Arterial', arterialWaitByTick, args.dt, args.windows),
        sideStreet: reportScope('Side-Streets', sideStreetWaitByTick, args.dt, args.windows),
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
            ? `=> The old 3600-tick warm-up is TOO SHORT here for at least one scope - batches probe their own (sim/warmupProbe.js); ~${recommended} by this run.`
            : `=> Current warm-up already covers every scope's measured convergence point (${slowest} <= ${CURRENT_WARMUP_TICKS} ticks) - no change needed, though bumping toward ~${recommended} would add cushion.`
    );
}

main();
