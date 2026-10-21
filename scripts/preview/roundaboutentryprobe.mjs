// Why a roundabout entry's front car isn't going in: samples each tick over a window and tallies the reason - its way
// out is full (exit held), the ring is closed to its approach (traffic coming, or another approach overdue), let in but
// waiting at the rim, or moving.
// node scripts/preview/roundaboutentryprobe.mjs <raw_config.json> <controller> <sensor|-> <power> <seed> <nodeId> [--from=simS] [--to=simS]
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { POWER_OUTAGE_START_TICK, POWER_OUTAGE_END_TICK, ROLLING_SCHEDULE } from '../../resources/js/sim/batchSchedule.js';

const [rawPath, controllerMode, sensorArg, powerState, seedArg, nodeId] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const cfg = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
for (const street of [...(cfg.arterials ?? []), ...(cfg.connectors ?? [])]) {
    const o = raw.demandOverrides?.[street.id];
    if (o) street.demand = { ...street.demand, spawnRatePerLanePerMinMin: o.min, spawnRatePerLanePerMinMax: o.max, saturationFlowPerLanePerHour: o.saturationFlowPerLanePerHour };
}
// ASSIGNMENT='{}' switches capacity-aware route choice on, as in batchreplay.mjs.
if (process.env.ASSIGNMENT) cfg.routing.assignment = process.env.ASSIGNMENT === 'off' ? null : JSON.parse(process.env.ASSIGNMENT);
const dt = 0.1;
const e = new SimulationEngine(buildLayout(cfg));
const arterialModes = {};
const demand = {};
for (const a of e.layout.arterials) { arterialModes[a.id] = controllerMode; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of e.layout.connectors) demand[c.id] = c.demand.spawnRatePerLanePerMin;
e.reset({ seed: Number(seedArg), arterialModes, demand, sensorMode: sensorArg === '-' ? null : sensorArg, batteryBackedSensors: true, power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: raw.routingMode });
const fromS = Number(opt('from', raw.warmupTicks * dt));
const toS = Number(opt('to', fromS + 1800));
const tally = new Map();
const gatesOf = (road) => {
    for (const cw of e.carriageways) if (cw.road === road) return cw.gates;
    for (const c of e.layout.connectors) for (const k of ['fwd', 'rev']) if (e.connectorDirs.get(c.id)[k].road === road) return e.connectorDirs.get(c.id)[k].gates;
    return [];
};
const add = (approachId, reason) => {
    if (!tally.has(approachId)) tally.set(approachId, {});
    const t = tally.get(approachId);
    t[reason] = (t[reason] ?? 0) + dt;
};
let darkKey = '';
for (let tick = 0; e.simTimeS < toS; tick += 1) {
    const m = tick - raw.warmupTicks;
    if (m === 0) e.resetStats();
    if (powerState === 'load_shedding' && m === POWER_OUTAGE_START_TICK) e.setManualLoadShedding(true);
    if (powerState === 'load_shedding' && m === POWER_OUTAGE_END_TICK) e.setManualLoadShedding(false);
    if (powerState === 'rolling_blackout' && m >= 0) {
        const zones = ROLLING_SCHEDULE.filter((w) => m >= w.fromTick && m < w.toTick).flatMap((w) => w.zones);
        const key = [...new Set(zones)].sort().join(',');
        if (key !== darkKey) { e.setZoneDark(zones); darkKey = key; }
    }
    e.tick(dt);
    if (e.simTimeS < fromS) continue;
    const info = e.nodesInfo.get(nodeId);
    const waitingAtRim = new Set([...info.roundaboutOccupants.values()].filter((o) => !o.entered).map((o) => o.approachId));
    for (const a of e._roundaboutArrivals(info)) {
        if (a.car.speedMps > 1) { add(a.approachId, 'moving'); continue; }
        if (info.roundaboutExitHeld?.has(a.car)) {
            const target = a.gate && e._roundaboutTarget(a.car, a.gate);
            let why = '?';
            if (target) {
                const mouthAtM = target.centreM + info.node.roundabout.mouthM;
                const tail = target.lanes[target.laneIndex].cars.filter((c) => c.distanceM > target.centreM).sort((p, q) => p.distanceM - q.distanceM)[0];
                if (!tail) why = 'ringCarsBoundThere';
                else {
                    const room = tail.distanceM - tail.lengthM / 2 - mouthAtM;
                    const reason = tail.speedMps > 1 ? 'tailMoving' : tail.trip?.drivewayWait ? 'tailWaitsForDriveway' : e._letInHold(tail, gatesOf(tail.road)) ? 'tailLettingIn' : e._drivewayHold(tail) ? 'tailDrivewayHold' : tail.turnPlan?.blockedSinceS != null ? 'tailTurnBlocked' : 'tailQueued';
                    why = `${reason} room<${room < 10 ? 10 : room < 30 ? 30 : room < 80 ? 80 : 'more'}m`;
                }
            }
            add(a.approachId, `exitHeld[${why}]`);
            continue;
        }
        if (!info.roundaboutOpenTo?.has(a.approachId)) { add(a.approachId, e._roundaboutTrafficComing(info, a.approachId) ? 'trafficComing' : 'otherOverdue'); continue; }
        add(a.approachId, 'open-but-stood');
    }
    for (const id of waitingAtRim) add(id, 'releasedNotIn');
}
for (const [id, t] of tally) console.log(id.padEnd(40), Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(0)}s`).join('  '));
