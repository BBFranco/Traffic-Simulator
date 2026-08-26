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
 *     [--reps=30] [--duration=24000] [--warmup-ticks=3600] [--base-seed=20260101]
 *     [--power-outage-start-tick=6000] [--power-outage-end-tick=12000]
 *     [--post=http://traffic-simulator.test/api/simulation-runs]
 *
 * --duration is in MEASURED ticks at dt=0.1s (24000 ticks = 40 simulated minutes
 * per run by default). --warmup-ticks (3600 = 6 simulated minutes by default) run
 * BEFORE that and are discarded from every stat - the standard traffic-sim
 * warm-up, long enough for this corridor's own from-empty ramp-up transient
 * (measured at ~150-250s to first reach a steady, fluctuating throughput) to
 * finish under normal power before anything gets measured. See engine.js's
 * resetStats() and runHeadless.js's warmupTicks doc for the mechanics.
 *
 * A load-shedding condition's outage starts a quarter of the way into the
 * MEASURED window (i.e. warm-up doesn't count) and power is restored at the
 * halfway mark, by default (25%/50% of --duration) - override either tick
 * explicitly if a different schedule is needed. Both must fall strictly
 * before --duration.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHeadless } from '../resources/js/sim/runHeadless.js';
import { buildExperimentalMatrix, seedForRep } from '../resources/js/sim/experimentalMatrix.js';
import { toApiPayload } from '../resources/js/sim/apiPayload.js';
import { accumulateRecoveryTicks, finalizeRecoveryTickPayload } from '../resources/js/sim/recoveryTickPayload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** POST batch size - mirrors the browser batch-run button's "every 20-30 completed runs" (build step 17). */
const POST_BATCH_SIZE = 25;

function parseArgs(argv) {
    const args = {
        corridor: 'hatfield-pretorius-francisbaard',
        reps: 30,
        duration: 24000,
        warmupTicks: 3600,
        baseSeed: 20260101,
        powerOutageStartTick: null,
        powerOutageEndTick: null,
        dt: 0.1,
        post: null,
    };
    for (const arg of argv) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'corridor') args.corridor = value;
        else if (key === 'reps') args.reps = Number(value);
        else if (key === 'duration') args.duration = Number(value);
        else if (key === 'warmup-ticks') args.warmupTicks = Number(value);
        else if (key === 'base-seed') args.baseSeed = Number(value);
        else if (key === 'power-outage-start-tick') args.powerOutageStartTick = Number(value);
        else if (key === 'power-outage-end-tick') args.powerOutageEndTick = Number(value);
        else if (key === 'dt') args.dt = Number(value);
        else if (key === 'post') args.post = value;
    }
    // Default outage schedule: starts a quarter of the way in, power restored at the
    // halfway mark - only filled in once `duration` is known, so a custom --duration
    // still gets a proportionally-placed outage.
    if (args.powerOutageStartTick == null) args.powerOutageStartTick = Math.round(args.duration * 0.25);
    if (args.powerOutageEndTick == null) args.powerOutageEndTick = Math.round(args.duration * 0.5);
    return args;
}

function toCsv(rows) {
    if (!rows.length) return '';
    const columns = Object.keys(rows[0]);
    const lines = [columns.join(',')];
    for (const row of rows) lines.push(columns.map((c) => row[c]).join(','));
    return lines.join('\n') + '\n';
}

const POST_RETRIES = 3;

/** Local Herd dev server occasionally drops the connection (ECONNRESET) under sustained
 * load - retry transient network failures a few times with backoff before giving up. */
async function postJson(url, body) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`POST ${url} -> ${response.status}: ${text.slice(0, 500)}`);
            }
            return;
        } catch (err) {
            if (attempt >= POST_RETRIES) throw err;
            console.warn(`  ! POST ${url} failed (attempt ${attempt}/${POST_RETRIES}): ${err.message ?? err}. Retrying...`);
            await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
    }
}

async function postBatch(url, payloads) {
    await postJson(url, { runs: payloads });
}

async function postRecoveryTicks(url, payload) {
    await postJson(url, payload);
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

        let recoveryAcc = null;

        for (let rep = 0; rep < args.reps; rep += 1) {
            const seed = seedForRep(args.baseSeed, condition.powerState, rep);
            const { rows, sideStreetRows, summary } = runHeadless({
                seed,
                controllerMode: condition.controllerMode,
                sensorMode: condition.sensorMode,
                warmupTicks: args.warmupTicks,
                powerOutageStartTick: condition.powerState === 'load_shedding' ? args.powerOutageStartTick : null,
                powerOutageEndTick: condition.powerState === 'load_shedding' ? args.powerOutageEndTick : null,
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

                // Every rep of a load-shedding condition folds into this condition's recovery
                // curve, so the chart on /results averages the same population the "time to
                // recovery" stat card does - posted once after the last rep, not batched like
                // the rest.
                if (condition.powerState === 'load_shedding') {
                    recoveryAcc = accumulateRecoveryTicks(recoveryAcc, { rows, sideStreetRows });
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

        if (args.post && recoveryAcc) {
            await postRecoveryTicks(
                args.post.replace(/\/[^/]+$/, '/recovery-ticks'),
                finalizeRecoveryTickPayload(recoveryAcc, {
                    controllerMode: condition.controllerMode,
                    sensorMode: condition.sensorMode,
                    dt: args.dt,
                    powerOutageStartTick: args.powerOutageStartTick,
                    powerOutageEndTick: args.powerOutageEndTick,
                })
            );
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
