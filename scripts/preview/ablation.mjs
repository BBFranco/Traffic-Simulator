// Coordinated-adaptive ablation probe: why do the side streets lose against fixed-time / adaptive?
// Each variant is the full mode with one thing changed, run batch-shaped (warm-up + 90 min measured, outage 15-30 min in)
// on the same seeds as the reference controllers, so the paired differences read straight off.
//
//   node scripts/preview/ablation.mjs [--seeds=2] [--jobs=4] [--sensor=inductive_loop] [--warm=49800] [--routing=destination]
//        [--variants=fixed,adaptive,full,platoon_off,side_cap,tuner_frozen] [--power=normal,load_shedding] [--out=ablation.json]
//
// Variants (coordination overrides, see equations.js COORDINATED_DEFAULTS):
//   full         - nothing changed
//   platoon_off  - platoonMessages false: the common cycle only, no platoon holds or early cross-green ends
//   side_cap     - sideWaitCap true: a cross call that has waited sideMaxWaitS takes the green (only the married junctions can hold it)
//   tuner_frozen - freezeAfterWarmup true: the self-tuner stops re-planning when the warm-up ends
//   divorce_crossings - divorceNodes: Grosvenor/Hilda/Festival on Pretorius and Francis Baard never marry (plain adaptive)
//   cross_shift  - crossShiftS 5: every married junction yields 5 s earlier, the cross street's window 5 s longer
//   side_cap_25  - sideWaitCap with sideMaxWaitS 25 (the 60 s default never fired)
// References: fixed, adaptive (same sensor). Memory: about 1 GB per job - keep --jobs to 4-6.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { seedForRep } from '../../resources/js/sim/experimentalMatrix.js';

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), '../..');
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;

const VARIANTS = {
    full: { controllerMode: 'coordinated_adaptive', coordination: {} },
    platoon_off: { controllerMode: 'coordinated_adaptive', coordination: { platoonMessages: false } },
    side_cap: { controllerMode: 'coordinated_adaptive', coordination: { sideWaitCap: true } },
    tuner_frozen: { controllerMode: 'coordinated_adaptive', coordination: { freezeAfterWarmup: true } },
    divorce_crossings: { controllerMode: 'coordinated_adaptive', coordination: { divorceNodes: ['pt_grosvenor', 'fb_hilda', 'fb_festival', 'fb_grosvenor'] } },
    cross_shift: { controllerMode: 'coordinated_adaptive', coordination: { crossShiftS: 5 } },
    cross_shift_8: { controllerMode: 'coordinated_adaptive', coordination: { crossShiftS: 8 } },
    cross_shift_10: { controllerMode: 'coordinated_adaptive', coordination: { crossShiftS: 10 } },
    cross_shift_12: { controllerMode: 'coordinated_adaptive', coordination: { crossShiftS: 12 } },
    side_cap_25: { controllerMode: 'coordinated_adaptive', coordination: { sideWaitCap: true, sideMaxWaitS: 25 } },
    adaptive: { controllerMode: 'adaptive', coordination: {} },
    fixed: { controllerMode: 'fixed', coordination: {} },
};

if (process.argv[2] === '--worker') {
    const job = JSON.parse(process.argv[3]);
    const corridorConfig = JSON.parse(readFileSync(path.join(root, 'corridors', 'hatfield-realistic.json'), 'utf8'));
    const shed = job.power === 'load_shedding';
    const { summary } = runHeadless({
        seed: job.seed,
        controllerMode: VARIANTS[job.variant].controllerMode,
        sensorMode: job.sensor,
        coordination: VARIANTS[job.variant].coordination,
        corridorConfig,
        routingMode: job.routing,
        warmupTicks: job.warm,
        durationTicks: 54000,
        powerOutageStartTick: shed ? 9000 : null,
        powerOutageEndTick: shed ? 18000 : null,
    });
    const coordination = summary.coordination;
    console.log(
        'RESULT ' +
            JSON.stringify({
                ...job,
                wait: summary.avgWaitTime,
                waitArterial: summary.avgWaitTimeArterial,
                waitSide: summary.avgWaitTimeSideStreet,
                p95Side: summary.p95WaitSideStreet,
                maxSide: summary.maxWaitSideStreet,
                p95: summary.p95Wait,
                throughput: summary.throughputPerMin,
                lost: summary.diagnostics?.arrivalsLost ?? null,
                married: coordination?.marriedShare ?? null,
                retunes: coordination ? Object.values(coordination.routes).reduce((sum, r) => sum + r.retunes, 0) : null,
                cycles: coordination ? Object.fromEntries(Object.entries(coordination.routes).map(([id, r]) => [id, [r.minCycleS, r.maxCycleS]])) : null,
                roadWaits: summary.roadWaits,
            })
    );
} else {
    const seeds = Number(arg('seeds', 2));
    const jobsAtOnce = Number(arg('jobs', 4));
    const variants = arg('variants', 'fixed,adaptive,full,platoon_off,side_cap,tuner_frozen').split(',');
    const powers = arg('power', 'normal,load_shedding').split(',');
    const sensor = arg('sensor', 'inductive_loop');
    const warm = Number(arg('warm', 49800));
    const routing = arg('routing', 'destination');
    const queue = [];
    for (const power of powers) {
        for (let rep = 0; rep < seeds; rep += 1) {
            for (const variant of variants) queue.push({ variant, power, seed: seedForRep(20260101, power, rep), sensor, warm, routing });
        }
    }
    console.log(`${queue.length} runs, ${jobsAtOnce} at a time (warm-up ${warm / 600} min, 90 min measured)...`);
    const results = [];
    const runNext = () =>
        new Promise((resolve) => {
            const job = queue.shift();
            if (!job) return resolve();
            const child = spawn(process.execPath, [here, '--worker', JSON.stringify(job)], { stdio: ['ignore', 'pipe', 'inherit'] });
            let out = '';
            child.stdout.on('data', (chunk) => (out += chunk));
            child.on('close', () => {
                const line = out.split('\n').find((l) => l.startsWith('RESULT '));
                if (line) results.push(JSON.parse(line.slice(7)));
                // Saved after every run - a long probe that dies late keeps what it finished.
                writeFileSync(path.resolve(root, arg('out', 'ablation.json')), JSON.stringify(results, null, 1));
                console.log(`  done ${job.variant} ${job.power} seed ${job.seed}${line ? '' : ' - FAILED'} (${results.length} ok)`);
                runNext().then(resolve);
            });
        });
    await Promise.all(Array.from({ length: jobsAtOnce }, runNext));

    writeFileSync(path.resolve(root, arg('out', 'ablation.json')), JSON.stringify(results, null, 1));
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const pct = (a, b) => ((a - b) / b) * 100;
    for (const power of powers) {
        console.log(`\n== ${power}  (mean over ${seeds} seeds; paired vs fixed / adaptive on the same seeds)`);
        console.log('variant        wait   arterial  side   sideP95 sideMax  thru  lost  married retunes | side vs fixed  side vs adaptive  total vs adaptive');
        const of = (variant) => results.filter((r) => r.variant === variant && r.power === power).sort((a, b) => a.seed - b.seed);
        for (const variant of variants) {
            const runs = of(variant);
            if (!runs.length) continue;
            const paired = (reference, key) => {
                const ref = of(reference);
                const diffs = runs.map((r) => [r, ref.find((x) => x.seed === r.seed)]).filter(([, x]) => x).map(([r, x]) => pct(r[key], x[key]));
                return diffs.length ? `${mean(diffs) >= 0 ? '+' : ''}${mean(diffs).toFixed(1)}%` : 'n/a';
            };
            const f = (key, d = 1) => (runs.some((r) => r[key] == null) ? '-' : mean(runs.map((r) => r[key])).toFixed(d));
            const married = runs[0].married == null ? '-' : `${(mean(runs.map((r) => r.married)) * 100).toFixed(1)}%`;
            console.log(
                `${variant.padEnd(13)} ${f('wait').padStart(6)} ${f('waitArterial').padStart(8)} ${f('waitSide').padStart(6)} ${f('p95Side', 0).padStart(7)} ${f('maxSide', 0).padStart(7)} ${f('throughput').padStart(6)} ${f('lost', 0).padStart(5)} ${married.padStart(7)} ${f('retunes', 0).padStart(7)} | ${paired('fixed', 'waitSide').padStart(13)} ${paired('adaptive', 'waitSide').padStart(17)} ${paired('adaptive', 'wait').padStart(18)}`
            );
        }
    }
}
