// Load shedding (rolling_blackout), stage 2 (zone 2 dark): what holds up zone 2's standing side-street queues. Each standing
// car's waitsOn chain is followed to its head; the head's nearest junction, its zone and whether it is dark say whether the
// queue is the dark all-way stop's own capacity or spillback from a lit junction. Stops at the final restore.
// node scripts/preview/backlogprobe.mjs <raw_config.json> <controller> <sensor|-> <seed>
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

const SNAP_MIN = [165, 195, 225, 254];
const snapshots = {};
// Zone 2 junction discharges during stage 2: cars whose nearest junction is a zone 2 node and that leave zone 2's wait.
let ticks = 0;

function heads(e) {
    const entries = e.lockupWatch._liveCars();
    const waitsOn = new Map(entries.map((x) => [x.car, x.waitsOn]));
    const out = { standingSide: 0, byHead: {}, byHeadNode: {} };
    for (const { car } of entries) {
        if (car.waitZone !== 2 || car.speedMps >= 0.5 || car.road?.statsKey !== 'side') continue;
        out.standingSide += 1;
        let head = car;
        const seen = new Set([car]);
        while (waitsOn.get(head) && !seen.has(waitsOn.get(head)) && waitsOn.get(head).speedMps < 0.5) { head = waitsOn.get(head); seen.add(head); }
        const nodeId = e.lockupWatch._nearestNodeId(head);
        const zone = e.zoneOfNode.get(nodeId) ?? '-';
        const dark = e.darkNodes.has(nodeId);
        const blocker = waitsOn.get(head) ? 'movingCar' : head.turnPath ? 'inBox' : 'stopLine';
        const key = `zone${zone}${dark ? 'Dark' : 'Lit'}/${blocker}`;
        out.byHead[key] = (out.byHead[key] ?? 0) + 1;
        out.byHeadNode[nodeId] = (out.byHeadNode[nodeId] ?? 0) + 1;
    }
    return out;
}

const tick = SimulationEngine.prototype.tick;
SimulationEngine.prototype.tick = function (dt) {
    tick.call(this, dt);
    ticks += 1;
    const t = ticks - raw.warmupTicks;
    if (t > 0 && t % 600 === 0 && SNAP_MIN.includes(t / 600)) snapshots[t / 600] = heads(this);
};

runHeadless({
    seed: Number(seedArg),
    controllerMode,
    sensorMode: sensorArg === '-' ? null : sensorArg,
    warmupTicks: raw.warmupTicks,
    rollingSchedule: LONG_PROTOCOL.rollingSchedule,
    corridorConfig: cfg,
    durationTicks: 255 * 600,
    dt: 0.1,
    routingMode: raw.routingMode,
    demandProfile: { profile: EVENING_PROFILE, startClockS: LONG_PROTOCOL.startClockS },
    sampleEverySeconds: LONG_PROTOCOL.sampleEverySeconds,
});

console.log(JSON.stringify({ run: `${controllerMode}/${sensorArg}/${seedArg}`, snapshots }));
