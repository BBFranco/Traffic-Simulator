// Load shedding (rolling_blackout) on the long protocol: what each controller leaves standing in zone 2 when it comes back
// at the final restore, and how its zone 2 signals split green between the arterial and the side streets afterwards.
// Tests why adaptive's post-restore wait is the worst under load shedding (Figure A4).
// node scripts/preview/restoreprobe.mjs <raw_config.json> <controller> <sensor|-> <seed>
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { LONG_PROTOCOL } from '../../resources/js/sim/batchSchedule.js';
import { EVENING_PROFILE } from '../../resources/js/sim/demandProfile.js';

const [rawPath, controllerMode, sensorArg, seedArg] = process.argv.slice(2);
const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const cfg = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
for (const street of [...(cfg.arterials ?? []), ...(cfg.connectors ?? [])]) {
    const o = raw.demandOverrides?.[street.id];
    if (o) street.demand = { ...street.demand, spawnRatePerLanePerMinMin: o.min, spawnRatePerLanePerMinMax: o.max, saturationFlowPerLanePerHour: o.saturationFlowPerLanePerHour };
}

const SIGNALS = new Set(['fixed', 'adaptive', 'coordinatedAdaptive', 'greenWave']);
const RESTORE_MIN = 255;
const snapshots = {};
const green = { arterial: 0, cross: 0, ticks: 0 };
const crossByNode = {};
let ticks = 0;
let zone2Inflow = { stage2: 0 };
const seen = new Set();

function standing(e) {
    const out = { zone2: 0, zone2Side: 0, zone2Art: 0, zone2SideWaitS: 0 };
    for (const { car } of e.lockupWatch._liveCars()) {
        if (car.waitZone !== 2 || car.speedMps >= 0.5) continue;
        out.zone2 += 1;
        const side = car.road.statsKey === 'side';
        if (side) { out.zone2Side += 1; out.zone2SideWaitS += car.totalWaitS ?? 0; } else out.zone2Art += 1;
    }
    out.zone2SideWaitS = Math.round(out.zone2SideWaitS / Math.max(1, out.zone2Side));
    return out;
}

const tick = SimulationEngine.prototype.tick;
SimulationEngine.prototype.tick = function (dt) {
    tick.call(this, dt);
    ticks += 1;
    const t = ticks - raw.warmupTicks;
    if (t <= 0) return;
    const min = t / 600;
    // Zone 2 inflow during stage 2 (zone 2 dark): cars that first get a zone 2 wait.
    if (min > 135 && min <= 255) {
        for (const { car } of this.lockupWatch._liveCars()) if (car.waitZone === 2 && !seen.has(car.id)) { seen.add(car.id); zone2Inflow.stage2 += 1; }
    }
    if (t % 600 === 0 && [135, 195, 254, 255, 265, 275, 285, 300].includes(min)) snapshots[min] = standing(this);
    // Green split at lit zone 2 signals over the first 30 min after the final restore.
    if (min > RESTORE_MIN && min <= RESTORE_MIN + 30) {
        for (const info of this.nodesInfo.values()) {
            if (this.zoneOfNode.get(info.node.id) !== 2 || !SIGNALS.has(info.controllerType) || !info.controller) continue;
            const art = info.controller.isArterialGreen();
            const cross = info.controller.isCrossGreen();
            green.ticks += 1;
            if (art) green.arterial += 1;
            if (cross) green.cross += 1;
            const c = (crossByNode[info.node.id] ??= { cross: 0, n: 0 });
            c.n += 1;
            if (cross) c.cross += 1;
        }
    }
};

runHeadless({
    seed: Number(seedArg),
    controllerMode,
    sensorMode: sensorArg === '-' ? null : sensorArg,
    warmupTicks: raw.warmupTicks,
    rollingSchedule: LONG_PROTOCOL.rollingSchedule,
    corridorConfig: cfg,
    durationTicks: LONG_PROTOCOL.measuredTicks,
    dt: 0.1,
    routingMode: raw.routingMode,
    demandProfile: { profile: EVENING_PROFILE, startClockS: LONG_PROTOCOL.startClockS },
    sampleEverySeconds: LONG_PROTOCOL.sampleEverySeconds,
});

console.log(JSON.stringify({
    run: `${controllerMode}/${sensorArg}/${seedArg}`,
    zone2InflowStage2: zone2Inflow.stage2,
    standing: snapshots,
    crossGreenShare: +(green.cross / green.ticks).toFixed(3),
    arterialGreenShare: +(green.arterial / green.ticks).toFixed(3),
    crossByNode: Object.fromEntries(Object.entries(crossByNode).map(([id, c]) => [id, +(c.cross / c.n).toFixed(2)])),
}));
