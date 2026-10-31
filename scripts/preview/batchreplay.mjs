// Replays one run of a /results batch exactly: template corridor + the batch's demand overrides, batch schedule.
// node scripts/preview/batchreplay.mjs <raw_config.json> <controller> <sensor|-> <power> <seed>
//   power: normal | load_shedding (total blackout) | rolling_blackout (load shedding)
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { MEASURED_TICKS, POWER_OUTAGE_START_TICK, POWER_OUTAGE_END_TICK, ROLLING_SCHEDULE } from '../../resources/js/sim/batchSchedule.js';

const [rawPath, controllerMode, sensorArg, powerState, seedArg] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const template = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
for (const street of [...(template.arterials ?? []), ...(template.connectors ?? [])]) {
    const o = raw.demandOverrides?.[street.id];
    if (o) street.demand = { ...street.demand, spawnRatePerLanePerMinMin: o.min, spawnRatePerLanePerMinMax: o.max, saturationFlowPerLanePerHour: o.saturationFlowPerLanePerHour };
}
// ASSIGNMENT='{}' (or its settings) switches capacity-aware route choice on for the replay; 'off' switches it off.
if (process.env.ASSIGNMENT) template.routing.assignment = process.env.ASSIGNMENT === 'off' ? null : JSON.parse(process.env.ASSIGNMENT);
const { summary } = runHeadless({
    seed: Number(seedArg), controllerMode, sensorMode: sensorArg === '-' ? null : sensorArg, routingMode: raw.routingMode, corridorConfig: template,
    warmupTicks: raw.warmupTicks, durationTicks: MEASURED_TICKS, dt: 0.1,
    powerOutageStartTick: powerState === 'load_shedding' ? POWER_OUTAGE_START_TICK : null,
    powerOutageEndTick: powerState === 'load_shedding' ? POWER_OUTAGE_END_TICK : null,
    rollingSchedule: powerState === 'rolling_blackout' ? ROLLING_SCHEDULE : null,
});
const { lockup } = summary.diagnostics;
console.log(JSON.stringify({ run: `${controllerMode}/${sensorArg}/${powerState}/${seedArg}`, avgWait: summary.avgWait?.toFixed?.(2), maxWait: Math.round(summary.maxWait ?? 0), longestStillS: Math.round(lockup.longestStillS), isLockup: lockup.isLockup, locked: lockup.locked, starved: lockup.starved }));
