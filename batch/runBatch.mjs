#!/usr/bin/env node
/**
 * batch/runBatch.mjs - build step 13's CLI driver, and the same generator
 * logic behind build step 18's "click the button" dataset.
 *
 * Runs every condition in the dissertation's experimental matrix (controller
 * mode x power state x sensor mode - 30 conditions total) against a corridor,
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
 *     [--reps=30] [--duration=54000] [--warmup-ticks=auto] [--probe-only] [--base-seed=20260101]
 *     [--power-outage-start-tick=9000] [--power-outage-end-tick=18000]
 *     [--post=http://traffic-simulator.test/api/simulation-runs] [--routing=random|destination]
 *     [--controllers=fixed,green_wave] [--power=normal,load_shedding,rolling_blackout] [--batch-id=<uuid>]
 *     [--webster-turn-weight] [--demand-scale=0.9] [--end-to-end-share=0.2] [--ablation=baseline|A1|A2|A3|A4|legacyRestart]
 *     [--protocol=short|long] [--sensors=inductive_loop,radar]
 *
 * --protocol=long runs batchSchedule.js's LONG_PROTOCOL (dissertation plan steps 7-8): 375 measured minutes from 16:15
 * on the evening demand profile, a 4 h total blackout or 2 h + 2 h zoned load shedding from 16:30, rows every 5 s and
 * each run's CSV gzipped. It sets --duration and both outage ticks itself. --sensors runs a subset of the sensor modes
 * (fixed-time and green wave, which read none, always run) - the pilot's loop-only matrix.
 *
 * A lockup that starts while junctions are dark is gridlock (lockupWatch.js), listed at the end but not a batch failure;
 * one that starts with every junction lit still fails the batch.
 *
 * --ablation runs coordinated adaptive with one of ablationArms.mjs's coordination overrides (baseline: none). The
 * overrides land in every coordinated run's raw config, which the batch line reads. Stored as a 'sensitivity' batch,
 * like a sweep point - an ablation batch never replaces the baseline on /results.
 *
 * --power runs a subset of the power states, and --batch-id posts into an existing batch: a full batch split per power
 * state (to stay inside the ~6-8 parallel-run memory limit) is one batch on /results. Pass the first part's warm-up
 * to the others as --warmup-ticks=<n> so every part measures from the same point.
 *
 * --resume=<batch id> carries on a batch that stopped (a crash, a lost connection, Ctrl+C) from where it got to. Every
 * batch keeps a checkpoint in results/batches/ - its settings, warm-up and code fingerprint, the runs already posted,
 * and each outage condition's recovery curve so far - written after every successful POST. A resume reruns only the
 * runs that never reached the server, with the batch's own settings (any other flags are ignored, --post excepted),
 * and refuses if the corridor or the simulation code changed since. A part of a split batch is resumed with its own
 * --power. The server skips a run it already holds, so a chunk re-posted after a lost reply is never stored twice.
 *
 * --webster-turn-weight runs the Webster sensitivity: a protected turn's q scaled by its weight.
 * --demand-scale / --end-to-end-share run a volume or through-trip sweep point (see withSweepSettings()).
 * --probe-only with --demand-scale is the volume acceptance test: does every controller settle inside the cap.
 * It is stored as a 'sensitivity' batch, so it never replaces the baseline on /results.
 *
 * --duration is in MEASURED ticks at dt=0.1s (54000 ticks = 90 simulated minutes
 * per run by default, sim/batchSchedule.js). --warmup-ticks run BEFORE that and are discarded from
 * every stat (engine.js's resetStats(), runHeadless.js's warmupTicks doc).
 * By default ('auto') they're measured for this corridor first by
 * sim/warmupProbe.js - one long from-empty run per controller - exactly as the
 * /results batch button does; pass a number to skip the probe. --probe-only
 * prints the probe's verdict and stops.
 *
 * A load-shedding (total blackout) condition's outage starts 15 min into the MEASURED window
 * (i.e. warm-up doesn't count) and power is restored at 30 min, by default
 * (sim/batchSchedule.js) - override either tick explicitly if a different
 * schedule is needed. Both must fall strictly before --duration. A rolling-blackout
 * condition runs batchSchedule.js's ROLLING_SCHEDULE (zones 1+3 dark 15-30 min, zone 2
 * 30-45 min) - the corridor needs its `zone`s (scripts/add-zones.mjs).
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runHeadless } from '../resources/js/sim/runHeadless.js';
import { buildExperimentalMatrix, seedForRep } from '../resources/js/sim/experimentalMatrix.js';
import { toApiPayload } from '../resources/js/sim/apiPayload.js';
import { accumulateRecoveryTicks, finalizeRecoveryTickPayload } from '../resources/js/sim/recoveryTickPayload.js';
import { probeConditions, probeCondition, chooseWarmup, PROBE_REPLICATIONS } from '../resources/js/sim/warmupProbe.js';
import { MEASURED_TICKS, POWER_OUTAGE_START_TICK, POWER_OUTAGE_END_TICK, ROLLING_SCHEDULE, LONG_PROTOCOL } from '../resources/js/sim/batchSchedule.js';
import { EVENING_PROFILE } from '../resources/js/sim/demandProfile.js';
import { buildStamp, simFingerprint } from './buildStamp.mjs';
import { ABLATION_ARMS } from './ablationArms.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** POST batch size - mirrors the browser batch-run button's "every 20-30 completed runs" (build step 17). */
const POST_BATCH_SIZE = 25;

function parseArgs(argv) {
    const args = {
        corridor: 'hatfield-pretorius-francisbaard',
        reps: 30,
        duration: MEASURED_TICKS,
        warmupTicks: 'auto',
        probeOnly: false,
        baseSeed: 20260101,
        powerOutageStartTick: null,
        powerOutageEndTick: null,
        dt: 0.1,
        post: null,
        routing: null,
        controllers: null,
        power: null,
        websterTurnWeight: false,
        demandScale: 1,
        endToEndShare: null,
        batchId: null,
        resume: null,
        ablation: null,
        protocol: 'short',
        sensors: null,
    };
    for (const arg of argv) {
        const [key, value] = arg.replace(/^--/, '').split('=');
        if (key === 'corridor') args.corridor = value;
        else if (key === 'reps') args.reps = Number(value);
        else if (key === 'duration') args.duration = Number(value);
        else if (key === 'warmup-ticks') args.warmupTicks = value === 'auto' ? 'auto' : Number(value);
        else if (key === 'probe-only') args.probeOnly = true;
        else if (key === 'base-seed') args.baseSeed = Number(value);
        else if (key === 'power-outage-start-tick') args.powerOutageStartTick = Number(value);
        else if (key === 'power-outage-end-tick') args.powerOutageEndTick = Number(value);
        else if (key === 'dt') args.dt = Number(value);
        else if (key === 'post') args.post = value;
        else if (key === 'routing') args.routing = value;
        else if (key === 'controllers') args.controllers = value.split(',');
        else if (key === 'power') args.power = value.split(',');
        else if (key === 'webster-turn-weight') args.websterTurnWeight = true;
        else if (key === 'demand-scale') args.demandScale = Number(value);
        else if (key === 'end-to-end-share') args.endToEndShare = Number(value);
        else if (key === 'batch-id') args.batchId = value;
        else if (key === 'resume') args.resume = value;
        else if (key === 'ablation') args.ablation = value;
        else if (key === 'protocol') args.protocol = value;
        else if (key === 'sensors') args.sensors = value.split(',');
    }
    if (!['short', 'long'].includes(args.protocol)) throw new Error(`--protocol=${args.protocol}: short or long.`);
    if (args.protocol === 'long') {
        args.duration = LONG_PROTOCOL.measuredTicks;
        args.powerOutageStartTick = LONG_PROTOCOL.powerOutageStartTick;
        args.powerOutageEndTick = LONG_PROTOCOL.powerOutageEndTick;
    }
    if (args.ablation != null && !ABLATION_ARMS[args.ablation]) throw new Error(`--ablation=${args.ablation}: not one of ${Object.keys(ABLATION_ARMS).join(', ')}.`);
    // Default outage schedule: 15-30 min into the measured window, whatever its length.
    if (args.powerOutageStartTick == null) args.powerOutageStartTick = POWER_OUTAGE_START_TICK;
    if (args.powerOutageEndTick == null) args.powerOutageEndTick = POWER_OUTAGE_END_TICK;
    return args;
}

function toCsv(rows) {
    if (!rows.length) return '';
    // Every row's keys, first-seen order - each arterial's rows carry their own junctions' queue columns.
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const lines = [columns.join(',')];
    for (const row of rows) lines.push(columns.map((c) => row[c] ?? '').join(','));
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

/** Measures the corridor's warm-up (sim/warmupProbe.js), printing each probe's per-scope verdict. */
function probeWarmup(corridorConfig, args) {
    const probes = [];
    for (const condition of probeConditions(args.controllers)) {
        console.log(`Warm-up probe: ${condition.controllerMode}, normal power, from empty, ${PROBE_REPLICATIONS} seeds averaged...`);
        // The long protocol probes on the short window at flat (peak) demand: its warm-up then ends at 16:15, on lighter
        // demand than the peak it settled under, so the probe's warm-up is a safe upper bound.
        const measuredTicks = args.protocol === 'long' ? MEASURED_TICKS : args.duration;
        const probe = probeCondition({ ...condition, corridorConfig, seeds: Array.from({ length: PROBE_REPLICATIONS }, (_, rep) => seedForRep(args.baseSeed, 'normal', rep)), dt: args.dt, measuredTicks, routingMode: args.routing });
        for (const [scope, v] of Object.entries(probe.scopes)) {
            if (v.truncationTick == null) continue;
            const at = `${((v.truncationTick * args.dt) / 60).toFixed(0)} min`;
            console.log(`  ${scope.padEnd(10)} ${v.stationary ? `levels off at ${at}` : `NOT stationary (still drifting ${(v.driftRatio * 100).toFixed(0)}% after ${at})`}`);
        }
        probes.push(probe);
    }
    const warmup = chooseWarmup(probes);
    console.log(
        `Warm-up: ${warmup.warmupTicks} ticks (${((warmup.warmupTicks * args.dt) / 60).toFixed(0)} min)` +
            (warmup.stationary ? '.' : ' - capped: at least one controller never reached a steady state, so this batch is flagged not stationary.')
    );
    return warmup;
}

/**
 * Sensitivity sweeps: --demand-scale multiplies every road's spawn rate (driveway departures follow their roads), and
 * --end-to-end-share sets routing.endToEndShare. Both are recorded on the config, so every run's raw_config_json says
 * what it ran with.
 */
function withSweepSettings(config, args) {
    if (args.demandScale !== 1) {
        for (const road of [...(config.arterials ?? []), ...(config.connectors ?? [])]) {
            for (const key of Object.keys(road.demand ?? {})) {
                if (key.startsWith('spawnRatePerLanePerMin')) road.demand[key] *= args.demandScale;
            }
        }
        config.demandScale = args.demandScale;
    }
    if (args.endToEndShare != null) {
        if (!config.routing) throw new Error('--end-to-end-share needs a corridor with a routing section.');
        config.routing.endToEndShare = args.endToEndShare;
    }
    return config;
}

/** The junction(s) a lockup is at: the waits-on cycle's, else where the stuck queue was. */
function lockupJunctions(lockup) {
    return lockup.firstCycle ? lockup.firstCycle.nodeIds.join(', ') : lockup.locked?.nodeId ?? 'unknown junction';
}

const CHECKPOINT_DIR = path.join(ROOT, 'results', 'batches');

/** Short sha1 of the corridor config and of the simulation code (buildStamp.mjs) - a resume must run exactly what the batch started on. */
function fingerprint(corridorConfig) {
    return {
        corridor: createHash('sha1').update(JSON.stringify(corridorConfig)).digest('hex').slice(0, 12),
        sim: simFingerprint(ROOT),
    };
}

/** A recovery accumulator (recoveryTickPayload.js) as plain JSON, and back. */
const accToJson = (acc) => acc && { reps: acc.reps, total: [...acc.total], arterial: [...acc.arterial], sideStreet: [...acc.sideStreet] };
const accFromJson = (json) => json && { reps: json.reps, total: new Map(json.total), arterial: new Map(json.arterial), sideStreet: new Map(json.sideStreet) };

/** The checkpoint `--resume=<batchId>` picks: the batch's only unfinished part, or the part run with the same --power. */
function findCheckpoint(batchId, power) {
    const files = fs.existsSync(CHECKPOINT_DIR) ? fs.readdirSync(CHECKPOINT_DIR).filter((name) => name.startsWith(`${batchId}`) && name.endsWith('.json')) : [];
    const parts = files.map((name) => ({ file: path.join(CHECKPOINT_DIR, name), checkpoint: JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, name), 'utf8')) }));
    if (!parts.length) throw new Error(`No checkpoint for batch ${batchId} in ${CHECKPOINT_DIR}.`);
    const samePower = (part) => (part.checkpoint.args.power ?? []).join(',') === (power ?? []).join(',');
    const candidates = power ? parts.filter(samePower) : parts.filter((part) => !part.checkpoint.finishedAt);
    if (candidates.length === 1) return candidates[0];
    if (!power && parts.every((part) => part.checkpoint.finishedAt)) throw new Error(`Batch ${batchId} already finished - nothing to resume.`);
    const listed = parts.map((part) => `--power=${(part.checkpoint.args.power ?? ['all']).join(',')}${part.checkpoint.finishedAt ? ' (finished)' : ''}`).join(', ');
    throw new Error(`Batch ${batchId} has ${candidates.length ? 'several unfinished parts' : 'no matching part'} (${listed}) - pass the part's --power.`);
}

async function main() {
    const cliArgs = parseArgs(process.argv.slice(2));
    const resumed = cliArgs.resume ? findCheckpoint(cliArgs.resume, cliArgs.power) : null;
    // A resume runs on the batch's own settings - only where it posts to can change.
    const args = resumed ? { ...resumed.checkpoint.args, post: cliArgs.post ?? resumed.checkpoint.args.post, probeOnly: false } : cliArgs;
    const corridorPath = path.join(ROOT, 'corridors', `${args.corridor}.json`);
    const corridorConfig = withSweepSettings(JSON.parse(fs.readFileSync(corridorPath, 'utf8')), args);
    const prints = fingerprint(corridorConfig);

    let checkpoint;
    let checkpointFile;
    if (resumed) {
        ({ checkpoint, file: checkpointFile } = resumed);
        if (checkpoint.finishedAt) throw new Error(`Batch ${checkpoint.batchId} already finished (${checkpoint.finishedAt}).`);
        if (checkpoint.fingerprint.corridor !== prints.corridor) throw new Error(`corridors/${args.corridor}.json changed since this batch started - a resume would mix two layouts.`);
        if (checkpoint.fingerprint.sim !== prints.sim) throw new Error('resources/js/sim changed since this batch started - a resume would mix two engines. Restore that code, or start a new batch.');
        console.log(`Resuming batch ${checkpoint.batchId}: ${Object.values(checkpoint.done).flat().length} runs already posted.`);
    } else {
        // Taken before the probe, so a batch's duration includes finding its warm-up.
        const batchStartedAt = new Date().toISOString();
        const build = buildStamp(ROOT, 'cli');
        const treeNote = build.dirty === null ? ' (tree state unknown - not a baseline batch)' : build.dirty ? ' (uncommitted changes - not a baseline batch)' : '';
        console.log(`Code: ${build.commit ?? 'not a git checkout'}${build.commit ? treeNote : ''}`);
        // A fixed --warmup-ticks is the caller's own choice - nothing measured says whether it's stationary.
        const warmup = args.warmupTicks === 'auto' ? probeWarmup(corridorConfig, args) : { warmupTicks: args.warmupTicks, stationary: null };
        if (args.probeOnly) return;
        const batchId = args.batchId ?? randomUUID();
        checkpoint = { batchId, args, warmup, batchStartedAt, build, fingerprint: prints, done: {}, recovery: {}, recoveryPosted: [], lockups: [], starved: [], mismatches: 0, finishedAt: null };
        fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
        checkpointFile = path.join(CHECKPOINT_DIR, `${batchId}${args.power ? `.${args.power.join('+')}` : ''}.json`);
        console.log(`Batch ${batchId}${args.batchId ? ' (posting into an existing batch)' : ''}. Resume it with --resume=${batchId}${args.power ? ` --power=${args.power.join(',')}` : ''} if it stops.`);
    }
    const { batchId, warmup, batchStartedAt, build } = checkpoint;
    const saveCheckpoint = () => fs.writeFileSync(checkpointFile, JSON.stringify(checkpoint));
    saveCheckpoint();

    const matrix = buildExperimentalMatrix()
        .filter((c) => !args.controllers || args.controllers.includes(c.controllerMode))
        .filter((c) => !args.power || args.power.includes(c.powerState))
        .filter((c) => !args.sensors || c.controllerMode === 'fixed' || c.controllerMode === 'green_wave' || args.sensors.includes(c.sensorMode));
    const long = args.protocol === 'long';
    const rollingWindows = long ? LONG_PROTOCOL.rollingSchedule : ROLLING_SCHEDULE;
    if (long) console.log(`Protocol: ${LONG_PROTOCOL.id} - ${args.duration * args.dt / 60} measured min, demand ${EVENING_PROFILE.id} from 16:15, outage from 16:30.`);
    // A sweep point is never the baseline: adopting a demand level means editing the corridor's own demand ranges.
    const batchKind = args.websterTurnWeight || args.demandScale !== 1 || args.endToEndShare != null || args.ablation != null ? 'sensitivity' : 'main';
    const arm = args.ablation != null ? ABLATION_ARMS[args.ablation] : null;
    if (arm) console.log(`Ablation: ${arm.label} ${JSON.stringify(arm.coordination)}`);
    if (matrix.some((c) => c.powerState === 'rolling_blackout') && ![...(corridorConfig.arterials ?? [])].some((a) => a.zone != null)) {
        throw new Error(`"${args.corridor}" has no zones - a rolling blackout needs them (scripts/add-zones.mjs).`);
    }
    const totalRuns = matrix.length * args.reps;
    let completed = Object.values(checkpoint.done).flat().length;
    const pendingPosts = [];
    /** Runs finished since the last successful POST - marked done only once the server has them. */
    let unposted = [];
    const recoveryAcc = Object.fromEntries(Object.entries(checkpoint.recovery).map(([key, json]) => [key, accFromJson(json)]));

    /** Posts what is pending, then records it - a crash before this line reruns those runs on resume, never skips them. */
    const flush = async () => {
        if (args.post && pendingPosts.length) await postBatch(args.post, pendingPosts.splice(0, pendingPosts.length));
        for (const { key, seed, mismatch, lockup, starved, gridlock, boxStuck } of unposted) {
            (checkpoint.done[key] ??= []).push(seed);
            if (mismatch) checkpoint.mismatches += 1;
            if (lockup) checkpoint.lockups.push(lockup);
            if (gridlock) (checkpoint.gridlocks ??= []).push(gridlock);
            if (boxStuck) (checkpoint.boxStuck ??= []).push(boxStuck);
            if (starved) checkpoint.starved.push(starved);
        }
        unposted = [];
        checkpoint.recovery = Object.fromEntries(Object.entries(recoveryAcc).map(([key, acc]) => [key, accToJson(acc)]));
        saveCheckpoint();
    };

    console.log(`Running ${matrix.length} conditions x ${args.reps} reps = ${totalRuns} runs against "${args.corridor}"${completed ? ` (${totalRuns - completed} left)` : ''}...`);
    if (args.post) console.log(`Will POST results to ${args.post} in batches of ${POST_BATCH_SIZE}.`);

    for (const condition of matrix) {
        // An ablation arm writes beside the others, never over them - the arms share condition keys.
        const outDir = path.join(ROOT, 'results', args.ablation ? `${condition.key}.${args.ablation}` : condition.key);
        fs.mkdirSync(outDir, { recursive: true });

        const outage = condition.powerState !== 'normal';
        const rollingSchedule = condition.powerState === 'rolling_blackout' ? rollingWindows : null;
        const done = new Set(checkpoint.done[condition.key] ?? []);

        for (let rep = 0; rep < args.reps; rep += 1) {
            const seed = seedForRep(args.baseSeed, condition.powerState, rep);
            if (done.has(seed)) continue;
            const runStartedMs = Date.now();
            const { rows, sideStreetRows, totalRows, arterialScopeRows, summary } = runHeadless({
                seed,
                controllerMode: condition.controllerMode,
                sensorMode: condition.sensorMode,
                warmupTicks: warmup.warmupTicks,
                powerOutageStartTick: condition.powerState === 'load_shedding' ? args.powerOutageStartTick : null,
                powerOutageEndTick: condition.powerState === 'load_shedding' ? args.powerOutageEndTick : null,
                rollingSchedule,
                corridorConfig,
                durationTicks: args.duration,
                dt: args.dt,
                routingMode: args.routing,
                websterTurnWeight: args.websterTurnWeight,
                coordination: arm?.coordination ?? {},
                ...(long ? { demandProfile: { profile: EVENING_PROFILE, startClockS: LONG_PROTOCOL.startClockS }, sampleEverySeconds: LONG_PROTOCOL.sampleEverySeconds } : {}),
            });

            if (long) fs.writeFileSync(path.join(outDir, `${seed}.long.csv.gz`), zlib.gzipSync(toCsv(rows)));
            else fs.writeFileSync(path.join(outDir, `${seed}.csv`), toCsv(rows));
            fs.writeFileSync(path.join(outDir, `${seed}${long ? '.long' : ''}.json`), JSON.stringify(summary, null, 2));

            // Its findings are recorded with the run itself (flush()), so a rerun after a crash never counts them twice.
            const run = { key: condition.key, seed, mismatch: false, lockup: null, starved: null, gridlock: null, boxStuck: null };
            if (!summary.carAccounting.balanced) {
                run.mismatch = true;
                console.warn(`  ! car accounting mismatch on ${condition.key}/${seed}: ${JSON.stringify(summary.carAccounting)}`);
            }

            const lockup = summary.diagnostics.lockup;
            if (lockup.isLockup) {
                run.lockup = `${condition.key}/${seed} at ${lockupJunctions(lockup)}`;
                console.warn(`  !!! LOCKUP on ${condition.key}, seed ${seed}, at ${lockupJunctions(lockup)}: ${JSON.stringify(lockup)}`);
            } else if (lockup.gridlock) {
                // Started while junctions were dark: gridlock under all-way stops, a result to report - not a fault.
                const g = lockup.gridlock.firstCycle ?? lockup.gridlock.locked;
                run.gridlock = `${condition.key}/${seed} at ${g.nodeIds?.join(', ') ?? g.nodeId} (${Math.round((g.atS - warmup.warmupTicks * args.dt) / 60)} min)`;
                console.warn(`  ! gridlock while dark on ${condition.key}, seed ${seed}: ${run.gridlock}`);
            } else if (lockup.starved) {
                // Saturation, not a fault: something ahead still moved. Listed at the end, doesn't fail the batch.
                run.starved = `${condition.key}/${seed} at ${lockup.starved.nodeId} (${lockup.starved.seconds} s)`;
            }

            if (lockup.boxStuck) {
                // Cars stood 2+ min inside a junction box (lockupWatch.js) - listed at the end, never a failure.
                const b = lockup.boxStuck;
                run.boxStuck = `${condition.key}/${seed}: ${b.cars} car(s) at ${Object.entries(b.byNode).map(([node, n]) => `${node} x${n}`).join(', ')}; longest ${b.longest.seconds} s (${b.longest.startedDark ? 'from dark' : 'lit'})`;
            }

            if (args.post) {
                pendingPosts.push(toApiPayload(summary, batchId, { warmupStationary: warmup.stationary, warmupDrifting: warmup.drifting ?? null, warmupSettle: warmup.settle ?? null, batchStartedAt, build, batchKind }));

                // Every rep of an outage condition folds into this condition's recovery
                // curve, so the chart on /results averages the same population the "time to
                // recovery" stat card does - posted once after the last rep, not batched like
                // the rest.
                if (outage) {
                    recoveryAcc[condition.key] = accumulateRecoveryTicks(recoveryAcc[condition.key] ?? null, { totalRows, arterialScopeRows, sideStreetRows });
                    checkpoint.darkWindows ??= {};
                    checkpoint.darkWindows[condition.key] = summary.darkWindows;
                }
            }
            unposted.push(run);

            completed += 1;
            if (long) {
                // A long run takes minutes - every one is reported, with its wall time and the process's peak memory so far.
                console.log(`  ${completed}/${totalRuns} (${condition.key}, seed ${seed}) ${((Date.now() - runStartedMs) / 1000).toFixed(0)} s, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`);
            } else if (completed % 10 === 0 || completed === totalRuns) {
                console.log(`  ${completed}/${totalRuns} (${condition.key}, seed ${seed})`);
            }

            // Without --post nothing waits on a server, so every run is recorded as it finishes.
            if (!args.post || pendingPosts.length >= POST_BATCH_SIZE) await flush();
        }

        // A sensitivity batch's recovery curves would replace the main batch's - keep them out.
        if (args.post && recoveryAcc[condition.key] && batchKind === 'main' && !checkpoint.recoveryPosted.includes(condition.key)) {
            // The condition's runs first, so a checkpoint never holds a posted curve over runs the server lacks.
            await flush();
            await postRecoveryTicks(
                args.post.replace(/\/[^/]+$/, '/recovery-ticks'),
                finalizeRecoveryTickPayload(recoveryAcc[condition.key], {
                    controllerMode: condition.controllerMode,
                    sensorMode: condition.sensorMode,
                    corridorId: corridorConfig.id,
                    dt: args.dt,
                    // A rolling blackout's curve spans its first cut to its final restore.
                    powerOutageStartTick: rollingSchedule ? rollingSchedule[0].fromTick : args.powerOutageStartTick,
                    powerOutageEndTick: rollingSchedule ? rollingSchedule[rollingSchedule.length - 1].toTick : args.powerOutageEndTick,
                    routingMode: args.routing ?? 'random',
                    powerState: condition.powerState,
                    darkWindows: checkpoint.darkWindows?.[condition.key] ?? null,
                })
            );
            checkpoint.recoveryPosted.push(condition.key);
            saveCheckpoint();
        }
    }

    await flush();
    checkpoint.finishedAt = new Date().toISOString();
    saveCheckpoint();

    const { starved, lockups, mismatches } = checkpoint;
    const gridlocks = checkpoint.gridlocks ?? [];
    const boxStuck = checkpoint.boxStuck ?? [];
    if (boxStuck.length) {
        console.log(`\n${boxStuck.length}/${totalRuns} runs had cars stood 2+ min inside a junction box:\n  ${boxStuck.join('\n  ')}`);
    }
    if (gridlocks.length) {
        console.log(`\n${gridlocks.length}/${totalRuns} runs gridlocked while dark (started under all-way stops - reported, not a fault):\n  ${gridlocks.join('\n  ')}`);
    }
    if (starved.length) {
        console.log(`\n${starved.length}/${totalRuns} runs had a starved approach (stood 5+ min behind a queue that still moved - saturation):\n  ${starved.join('\n  ')}`);
    }
    if (lockups.length) {
        console.warn(`\n!!! ${lockups.length}/${totalRuns} runs locked up - do not read this batch until they are fixed:\n  ${lockups.join('\n  ')}`);
        process.exitCode = 1;
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
