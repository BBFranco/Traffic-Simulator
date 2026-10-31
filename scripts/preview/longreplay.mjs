// Replays one stored long-protocol batch run exactly as /results ran it (results.js runBatch(): template corridor + the
// run's demand overrides, its warm-up, the long schedule and evening profile) and prints the figures to compare with the row.
// node scripts/preview/longreplay.mjs <raw_config.json> <power: normal|load_shedding|rolling_blackout>
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { LONG_PROTOCOL } from '../../resources/js/sim/batchSchedule.js';
import { EVENING_PROFILE } from '../../resources/js/sim/demandProfile.js';

const [rawPath, powerState] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const cfg = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
for (const street of [...(cfg.arterials ?? []), ...(cfg.connectors ?? [])]) {
    const o = raw.demandOverrides?.[street.id];
    if (o) street.demand = { ...street.demand, spawnRatePerLanePerMinMin: o.min, spawnRatePerLanePerMinMax: o.max, saturationFlowPerLanePerHour: o.saturationFlowPerLanePerHour };
}
const started = Date.now();
const { summary } = runHeadless({
    seed: raw.seed,
    controllerMode: raw.controllerMode,
    sensorMode: raw.sensorMode,
    warmupTicks: raw.warmupTicks,
    powerOutageStartTick: powerState === 'load_shedding' ? LONG_PROTOCOL.powerOutageStartTick : null,
    powerOutageEndTick: powerState === 'load_shedding' ? LONG_PROTOCOL.powerOutageEndTick : null,
    rollingSchedule: powerState === 'rolling_blackout' ? LONG_PROTOCOL.rollingSchedule : null,
    corridorConfig: cfg,
    durationTicks: LONG_PROTOCOL.measuredTicks,
    dt: 0.1,
    routingMode: raw.routingMode,
    demandProfile: { profile: EVENING_PROFILE, startClockS: LONG_PROTOCOL.startClockS },
    sampleEverySeconds: LONG_PROTOCOL.sampleEverySeconds,
});
const { lockup } = summary.diagnostics;
console.log(JSON.stringify({
    run: `${raw.controllerMode}/${raw.sensorMode}/${powerState}/${raw.seed}`,
    avgWaitTime: summary.avgWaitTime,
    throughputPerMin: summary.throughputPerMin,
    maxWait: summary.maxWait,
    arrivalsBalked: summary.diagnostics.arrivalsBalked,
    longestStill: lockup.longestStill,
    sim: summary.rawConfig?.build?.sim ?? null,
    seconds: Math.round((Date.now() - started) / 1000),
}));
