/**
 * Sensor overhaul smoke probe (step 6): every sensor under the field specs and the legacy reproduction, adaptive and
 * coordinated adaptive, normal power, destination routing. 2 seeds per variant - a smoke test, not proof of separation.
 *
 *   node scripts/preview/sensorProbe.mjs [--seeds=2] [--jobs=4] [--warmup-min=20] [--measure-min=40]
 *
 * Prints one row per condition (mean over seeds) and writes results/sensor-probe-<date>.json (git-ignored).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const SEEDS = arg('seeds', 2);
const JOBS = arg('jobs', 4);
const WARMUP_TICKS = arg('warmup-min', 20) * 600;
const MEASURE_TICKS = arg('measure-min', 40) * 600;
const FIELDS = ['avgWaitTime', 'avgWaitTimeArterial', 'avgWaitTimeSideStreet', 'throughputPerMin', 'pctClearedWithoutStop', 'p95Wait'];

if (process.argv.includes('--child')) {
    const { runHeadless } = await import('../../resources/js/sim/runHeadless.js');
    const corridorConfig = JSON.parse(fs.readFileSync(path.join(root, 'corridors', 'hatfield-realistic.json'), 'utf8'));
    process.on('message', (job) => {
        const { summary } = runHeadless({ ...job, corridorConfig, warmupTicks: WARMUP_TICKS, durationTicks: MEASURE_TICKS, routingMode: 'destination' });
        process.send({ job, metrics: Object.fromEntries(FIELDS.map((f) => [f, summary[f]])) });
    });
} else {
    const jobs = [];
    for (const sensorSpecSet of ['field', 'legacy']) {
        for (const controllerMode of ['adaptive', 'coordinated_adaptive']) {
            for (const sensorMode of ['inductive_loop', 'magnetometer', 'radar', 'camera']) {
                for (let seed = 1; seed <= SEEDS; seed += 1) jobs.push({ seed, controllerMode, sensorMode, sensorSpecSet });
            }
        }
    }
    const results = [];
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(JOBS, jobs.length) }, () => new Promise((resolve) => {
            const child = fork(fileURLToPath(import.meta.url), [...process.argv.slice(2), '--child']);
            const feed = () => (next < jobs.length ? child.send(jobs[next++]) : (child.kill(), resolve()));
            child.on('message', (result) => {
                results.push(result);
                process.stderr.write(`${results.length}/${jobs.length}\r`);
                feed();
            });
            feed();
        }))
    );
    const groups = new Map();
    for (const { job, metrics } of results) {
        const key = `${job.sensorSpecSet}|${job.controllerMode}|${job.sensorMode}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(metrics);
    }
    const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, runs]) => ({
        key,
        ...Object.fromEntries(FIELDS.map((f) => [f, Number((runs.reduce((s, r) => s + r[f], 0) / runs.length).toFixed(2))])),
    }));
    console.table(rows);
    const out = path.join(root, 'results', `sensor-probe-${new Date().toISOString().slice(0, 10)}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify({ seeds: SEEDS, warmupTicks: WARMUP_TICKS, measureTicks: MEASURE_TICKS, rows, runs: results }, null, 2)}\n`);
    console.log(`wrote ${out}`);
}
