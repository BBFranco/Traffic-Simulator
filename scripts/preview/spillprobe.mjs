// Load shedding (rolling_blackout), stage 2: time-averaged (every 60 s, min 195-255) heads of zone 2 standing side-street queues,
// and the green split at the lit zone 1 Jan Shoba junctions those queues back up from. Stops at the final restore.
// node scripts/preview/spillprobe.mjs <raw_config.json> <controller> <sensor|-> <seed>
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

const SAMPLE = { from: 195, to: 255 };
const SPILL_NODES = ["lynnwood_janshoba", "duxbury_janshoba"];
const sums = { samples: 0, standingSide: 0, byHead: {}, byHeadNode: {} };
const green = Object.fromEntries(SPILL_NODES.map((id) => [id, { ticks: 0, arterial: 0, cross: 0, turn: 0, crossStarts: 0, wasCross: false }]));
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
    if (t <= 0) return;
    const min = t / 600;
    if (min <= SAMPLE.from || min > SAMPLE.to) return;
    // Green split at the lit zone 1 Jan Shoba junctions that zone 2's queues back up from.
    for (const id of SPILL_NODES) {
        const info = this.nodesInfo.get(id);
        const g = green[id];
        const cross = info.controller.isCrossGreen();
        g.ticks += 1;
        if (info.controller.isArterialGreen()) g.arterial += 1;
        if (cross) g.cross += 1;
        if (info.controller.inTurn) g.turn += 1;
        if (cross && !g.wasCross) g.crossStarts += 1;
        g.wasCross = cross;
    }
    if (t % 600 !== 0) return;
    const h = heads(this);
    sums.samples += 1;
    sums.standingSide += h.standingSide;
    for (const [k, v] of Object.entries(h.byHead)) sums.byHead[k] = (sums.byHead[k] ?? 0) + v;
    for (const [k, v] of Object.entries(h.byHeadNode)) sums.byHeadNode[k] = (sums.byHeadNode[k] ?? 0) + v;
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

const avg = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v / sums.samples >= 5).map(([k, v]) => [k, Math.round(v / sums.samples)]));
console.log(JSON.stringify({
    run: `${controllerMode}/${sensorArg}/${seedArg}`,
    meanStandingSide: Math.round(sums.standingSide / sums.samples),
    byHead: avg(sums.byHead),
    byHeadNode: avg(sums.byHeadNode),
    green: Object.fromEntries(Object.entries(green).map(([id, g]) => [id, { arterial: +(g.arterial / g.ticks).toFixed(3), cross: +(g.cross / g.ticks).toFixed(3), turn: +(g.turn / g.ticks).toFixed(3), meanCrossGreenS: +(g.cross / 10 / Math.max(1, g.crossStarts)).toFixed(1), crossStarts: g.crossStarts }])),
}));
