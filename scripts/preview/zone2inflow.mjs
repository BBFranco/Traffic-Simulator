// Zone 2 inflow and standing queue, per minute, through load shedding (rolling_blackout) - does a controller's
// faster stage-2 discharge in lit zones 1+3 feed dark zone 2 more? Counts cars whose wait is charged to zone 2.
// node scripts/preview/zone2inflow.mjs <raw_config.json> <controller> <sensor|-> <seed>
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { MEASURED_TICKS, ROLLING_SCHEDULE } from '../../resources/js/sim/batchSchedule.js';

const [rawPath, controllerMode, sensorArg, seedArg] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const template = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
for (const street of [...(template.arterials ?? []), ...(template.connectors ?? [])]) {
    const o = raw.demandOverrides?.[street.id];
    if (o) street.demand = { ...street.demand, spawnRatePerLanePerMinMin: o.min, spawnRatePerLanePerMinMax: o.max, saturationFlowPerLanePerHour: o.saturationFlowPerLanePerHour };
}

let ticks = 0;
const seen = new Set();
const perMin = [];
let inflow = 0;
const tick = SimulationEngine.prototype.tick;
SimulationEngine.prototype.tick = function (dt) {
    tick.call(this, dt);
    ticks += 1;
    const m = ticks - raw.warmupTicks;
    if (m < 20 * 600 || m > 55 * 600) return;
    let stopped = 0;
    for (const { car } of this.lockupWatch._liveCars()) {
        if (car.waitZone !== 2) continue;
        if (!seen.has(car.id)) { seen.add(car.id); inflow += 1; }
        if (car.speedMps < 0.5) stopped += 1;
    }
    if (m % 600 === 0) { perMin.push({ min: m / 600, inflow, stopped }); inflow = 0; }
};

runHeadless({
    seed: Number(seedArg), controllerMode, sensorMode: sensorArg === '-' ? null : sensorArg, routingMode: raw.routingMode, corridorConfig: template,
    warmupTicks: raw.warmupTicks, durationTicks: 56 * 600, dt: 0.1, rollingSchedule: ROLLING_SCHEDULE,
});
const sum = (a, b, k) => perMin.filter((r) => r.min > a && r.min <= b).reduce((s, r) => s + r[k], 0);
const mean = (a, b, k) => sum(a, b, k) / perMin.filter((r) => r.min > a && r.min <= b).length;
console.log(JSON.stringify({ run: `${controllerMode}/${sensorArg}/${seedArg}`,
    inflowStage1Last10: sum(20, 30, 'inflow'), inflowStage2: sum(30, 45, 'inflow'), inflowStage2First5: sum(30, 35, 'inflow'),
    stoppedAt30: perMin.find((r) => r.min === 30)?.stopped, stoppedStage2Mean: +mean(30, 45, 'stopped').toFixed(1), stoppedAt45: perMin.find((r) => r.min === 45)?.stopped }));
