// One batch-shaped run (warm-up + 60 min measured, load-shedding outage 15-30 min) - its headline numbers and lockup report.
// node scripts/preview/runcheck.mjs <controller> <sensor> <seed> [--routing=random] [--warm=36000]
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';

const [controllerMode, sensorMode, seedArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const corridorConfig = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
const { summary } = runHeadless({
    seed: Number(seedArg), controllerMode, sensorMode, routingMode: opt('routing', 'random'), corridorConfig,
    warmupTicks: Number(opt('warm', 36000)), durationTicks: 36000, powerOutageStartTick: 9000, powerOutageEndTick: 18000, sampleEverySeconds: 10,
});
const { lockup } = summary.diagnostics;
console.log(JSON.stringify({
    run: `${controllerMode}/${sensorMode}/${seedArg}`, avgWait: summary.avgWait?.toFixed?.(1), maxWait: summary.maxWait?.toFixed?.(0),
    thrPerMin: summary.throughputPerMin?.toFixed?.(1), longestStillS: Math.round(lockup.longestStillS), isLockup: lockup.isLockup,
    locked: lockup.locked, starved: lockup.starved,
}));
