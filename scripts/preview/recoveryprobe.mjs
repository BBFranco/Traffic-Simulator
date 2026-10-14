// How long after power returns each scope's wait and throughput take to get back to their pre-cut level, with a long
// measured tail - to size the batch window. node scripts/preview/recoveryprobe.mjs <controller> <sensor> <seed>
//   [--tail-min=150] [--routing=destination] [--warm=54000] [--normal]   (outage at measured 15-30 min, as in a batch;
//   --normal: no outage, to see whether the controller drifts on its own over the same window)
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';

const [controllerMode, sensorMode, seedArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const corridorConfig = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
const tailTicks = Number(opt('tail-min', 150)) * 600;
const normal = process.argv.includes('--normal');
const { summary, totalRows } = runHeadless({
    seed: Number(seedArg), controllerMode, sensorMode, routingMode: opt('routing', 'destination'), corridorConfig,
    warmupTicks: Number(opt('warm', 54000)), durationTicks: 18000 + tailTicks, ...(normal ? {} : { powerOutageStartTick: 9000, powerOutageEndTick: 18000 }), sampleEverySeconds: 10,
});
const s = (v) => (v == null ? 'never' : `${Math.round(v)}`);
console.log(JSON.stringify({
    run: `${controllerMode}/${sensorMode}/${seedArg}`,
    waitRecoveryS: { total: s(summary.timeToRecoveryWaitSeconds), arterial: s(summary.timeToRecoveryWaitSecondsArterial), side: s(summary.timeToRecoveryWaitSecondsSideStreet) },
    thruRecoveryS: s(summary.timeToRecoverySeconds),
    lockup: summary.diagnostics.lockup.isLockup,
}));
// Mean wait of the vehicles cleared in each block, from the cumulative counters: pre-cut, the outage, then 30 min blocks.
const at = (tick) => totalRows.reduce((best, row) => (row.tick <= tick ? row : best), totalRows[0]);
const blocks = [[0, 9000, 'pre'], [9000, 18000, 'out']];
for (let start = 18000; start < 18000 + tailTicks; start += 18000) blocks.push([start, start + 18000, `+${(start - 18000) / 600}m`]);
console.log('  wait by block:', blocks.map(([from, to, label]) => {
    const a = at(from), b = at(to);
    const cleared = b.clearedTotal - a.clearedTotal;
    return `${label} ${cleared ? ((b.waitSumTotal - a.waitSumTotal) / cleared).toFixed(1) : '-'}`;
}).join(' | '));
