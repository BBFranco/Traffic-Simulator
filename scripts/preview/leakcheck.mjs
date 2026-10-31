// Runs stored long-protocol runs back to back in ONE process, as a /results batch worker does, and prints each
// summary - a run whose figures change with what ran before it in the process shows state leaking between runs.
// node scripts/preview/leakcheck.mjs <power> <raw_config.json> [<raw_config.json> ...]
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { LONG_PROTOCOL } from '../../resources/js/sim/batchSchedule.js';
import { EVENING_PROFILE } from '../../resources/js/sim/demandProfile.js';

const [powerState, ...rawPaths] = process.argv.slice(2);
const template = readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8');
const durationTicks = Number(process.env.TICKS ?? LONG_PROTOCOL.measuredTicks);
for (const rawPath of rawPaths) {
    const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
    const cfg = JSON.parse(template);
    for (const street of [...(cfg.arterials ?? []), ...(cfg.connectors ?? [])]) {
        const o = raw.demandOverrides?.[street.id];
        if (o) street.demand = { ...street.demand, spawnRatePerLanePerMinMin: o.min, spawnRatePerLanePerMinMax: o.max, saturationFlowPerLanePerHour: o.saturationFlowPerLanePerHour };
    }
    const { summary } = runHeadless({
        seed: raw.seed, controllerMode: raw.controllerMode, sensorMode: raw.sensorMode, warmupTicks: Number(process.env.WARMUP ?? raw.warmupTicks),
        powerOutageStartTick: powerState === 'load_shedding' ? LONG_PROTOCOL.powerOutageStartTick : null,
        powerOutageEndTick: powerState === 'load_shedding' ? LONG_PROTOCOL.powerOutageEndTick : null,
        rollingSchedule: powerState === 'rolling_blackout' ? LONG_PROTOCOL.rollingSchedule : null,
        corridorConfig: cfg, durationTicks, dt: 0.1, routingMode: raw.routingMode,
        demandProfile: { profile: EVENING_PROFILE, startClockS: LONG_PROTOCOL.startClockS }, sampleEverySeconds: LONG_PROTOCOL.sampleEverySeconds,
    });
    console.log(JSON.stringify({ seed: raw.seed, mode: raw.controllerMode, sensor: raw.sensorMode, avgWaitTime: summary.avgWaitTime, throughputPerMin: summary.throughputPerMin }));
}
