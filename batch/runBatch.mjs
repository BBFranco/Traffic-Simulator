#!/usr/bin/env node
/**
 * batch/runBatch.mjs - build step 13's CLI driver, and the same generator
 * logic behind build step 18's "click the button" dataset.
 *
 * Runs every condition in the dissertation's experimental matrix (controller
 * mode x power state x sensor mode - 12 conditions total) against a corridor,
 * REPS times each with a distinct seed, and writes one CSV (time series) +
 * one JSON (summary) per run into results/<condition>/<seed>.{csv,json}.
 *
 * This file does the disk I/O and CLI argument parsing; the actual
 * simulation step-by-step logic is runHeadless.js, which is isomorphic
 * (no fs, no DOM) so the exact same function also runs from the /results
 * page's batch-run button (build step 17).
 *
 * Usage:
 *   node batch/runBatch.mjs [--corridor=hatfield-pretorius-francisbaard]
 *     [--reps=30] [--duration=3600] [--base-seed=20260101]
 *     [--power-event-tick=1800] [--post=http://traffic-simulator.test/api/simulation-runs]
 *
 * --duration is in ticks at dt=0.1s (3600 ticks = 6 simulated minutes per
 * run by default - raise it for a dissertation-grade dataset; kept short
 * here so a full 360-run pass is quick to smoke-test).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHeadless } from '../resources/js/sim/runHeadless.js';
import { buildExperimentalMatrix, seedForRep } from '../resources/js/sim/experimentalMatrix.js';
import { toApiPayload } from '../resources/js/sim/apiPayload.js';
import { buildRecoveryTickPayload } from '../resources/js/sim/recoveryTickPayload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** POST batch size - mirrors the browser batch-run button's "every 20-30 completed runs" (build step 17). */
const POST_BATCH_SIZE = 25;

function parseArgs(argv) {
    const args = {
        corridor: 'hatfield-pretorius-francisbaard',
        reps: 30,
        duration: 3600,
        baseSeed: 20260101,
        powerEventTick: 1800,
        dt: 0.1,
        post: null,
    };
    for (const arg of argv) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'corridor') args.corridor = value;
        else if (key === 'reps') args.reps = Number(value);
        else if (key === 'duration') args.duration = Number(value);
        else if (key === 'base-seed') args.baseSeed = Number(value);
        else if (key === 'power-event-tick') args.powerEventTick = Number(value);
        else if (key === 'dt') args.dt = Number(value);
        else if (key === 'post') args.post = value;
    }
    return args;
}

function toCsv(rows) {
    if (!rows.length) return '';
    const columns = Object.keys(rows[0]);
    const lines = [columns.join(',')];
    for (const row of rows) lines.push(columns.map((c) => row[c]).join(','));
    return lines.join('\n') + '\n';
}

async function postBatch(url, payloads) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ runs: payloads }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`POST ${url} -> ${response.status}: ${body.slice(0, 500)}`);
    }
}

async function postRecoveryTicks(url, payload) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`POST ${url} -> ${response.status}: ${body.slice(0, 500)}`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const corridorPath = path.join(ROOT, 'corridors', `${args.corridor}.json`);
    const corridorConfig = JSON.parse(fs.readFileSync(corridorPath, 'utf8'));

    const matrix = buildExperimentalMatrix();
    const totalRuns = matrix.length * args.reps;
    let completed = 0;
    let mismatches = 0;
    const pendingPosts = [];

    console.log(`Running ${matrix.length} conditions x ${args.reps} reps = ${totalRuns} runs against "${args.corridor}"...`);
    if (args.post) console.log(`Will POST results to ${args.post} in batches of ${POST_BATCH_SIZE}.`);

    for (const condition of matrix) {
        const outDir = path.join(ROOT, 'results', condition.key);
        fs.mkdirSync(outDir, { recursive: true });

        for (let rep = 0; rep < args.reps; rep += 1) {
            const seed = seedForRep(args.baseSeed, condition.powerState, rep);
            const { rows, sideStreetRows, summary } = runHeadless({
                seed,
                controllerMode: condition.controllerMode,
                sensorMode: condition.sensorMode,
                powerEvent: condition.powerState === 'load_shedding' ? args.powerEventTick : null,
                corridorConfig,
                durationTicks: args.duration,
                dt: args.dt,
            });

            fs.writeFileSync(path.join(outDir, `${seed}.csv`), toCsv(rows));
            fs.writeFileSync(path.join(outDir, `${seed}.json`), JSON.stringify(summary, null, 2));

            if (!summary.carAccounting.balanced) {
                mismatches += 1;
                console.warn(`  ! car accounting mismatch on ${condition.key}/${seed}: ${JSON.stringify(summary.carAccounting)}`);
            }

            if (args.post) {
                pendingPosts.push(toApiPayload(summary));

                // Rep 0 of a load-shedding condition is this condition's representative run for
                // the recovery chart on /results - posted once, not batched like the rest.
                if (rep === 0 && condition.powerState === 'load_shedding') {
                    await postRecoveryTicks(
                        args.post.replace(/\/[^/]+$/, '/recovery-ticks'),
                        buildRecoveryTickPayload({
                            controllerMode: condition.controllerMode,
                            sensorMode: condition.sensorMode,
                            rows,
                            sideStreetRows,
                            dt: args.dt,
                            powerEventTick: args.powerEventTick,
                        })
                    );
                }
            }

            completed += 1;
            if (completed % 10 === 0 || completed === totalRuns) {
                console.log(`  ${completed}/${totalRuns} (${condition.key}, seed ${seed})`);
            }

            if (args.post && pendingPosts.length >= POST_BATCH_SIZE) {
                await postBatch(args.post, pendingPosts.splice(0, pendingPosts.length));
            }
        }
    }

    if (args.post && pendingPosts.length) {
        await postBatch(args.post, pendingPosts);
    }

    if (mismatches) {
        console.warn(`Done, but ${mismatches}/${totalRuns} runs failed the car-conservation check - see warnings above.`);
        process.exitCode = 1;
    } else {
        console.log('Done. All runs passed the car-conservation check.');
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
