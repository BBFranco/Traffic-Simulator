/**
 * Long-outage pilot (dissertation plan step 9): is the 53-min warm-up still long enough on the evening profile?
 * Normal power, same seeds, warm-up 53 vs 106 min, both ending at 16:15: if the first 15 measured minutes (the outage
 * runs' pre-cut baseline) match within seed noise, the shorter warm-up has left no from-empty transient behind.
 *
 *   node scripts/preview/longWarmupCheck.mjs [controller=fixed] [seeds=3]
 */
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { loadCorridor } from '../../batch/trajectoryHash.mjs';
import { EVENING_PROFILE } from '../../resources/js/sim/demandProfile.js';
import { LONG_PROTOCOL } from '../../resources/js/sim/batchSchedule.js';

const controllerMode = process.argv[2] ?? 'fixed';
const seeds = Number(process.argv[3] ?? 3);
const config = loadCorridor('hatfield-realistic');
const PRE_TICKS = LONG_PROTOCOL.powerOutageStartTick;

for (let rep = 0; rep < seeds; rep += 1) {
    const seed = 20260101 + rep;
    const out = [];
    for (const warmupTicks of [31800, 63600]) {
        const { summary } = runHeadless({
            seed,
            controllerMode,
            sensorMode: 'inductive_loop',
            warmupTicks,
            corridorConfig: config,
            durationTicks: 2 * PRE_TICKS,
            routingMode: 'destination',
            demandProfile: { profile: EVENING_PROFILE, startClockS: LONG_PROTOCOL.startClockS },
            sampleEverySeconds: LONG_PROTOCOL.sampleEverySeconds,
        });
        const series = summary.diagnostics.waitSeries.total.slice(0, PRE_TICKS / 600);
        const mean = series.reduce((a, b) => a + b, 0) / series.length;
        out.push(`warm-up ${warmupTicks / 600} min: first 15 min wait ${mean.toFixed(2)} s, on network ${summary.carAccounting.onRoadNetwork}`);
    }
    console.log(`${controllerMode} seed ${seed}: ${out.join(' | ')}`);
}
