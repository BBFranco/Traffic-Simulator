// Measured discharge per junction approach in one replayed batch run: how many cars crossed each approach's stop/yield
// line, how much of the time it had a standing queue at the line, and the rate it discharged at while it did - the
// junction's working capacity in the simulation, to set against textbook capacity (routing/assignment.js).
// node scripts/preview/dischargeprobe.mjs <raw_config.json> <controller> <sensor|-> <power> <seed> [--nodes=a,b] [--from=simS] [--to=simS]
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { POWER_OUTAGE_START_TICK, POWER_OUTAGE_END_TICK, ROLLING_SCHEDULE } from '../../resources/js/sim/batchSchedule.js';

const [rawPath, controllerMode, sensorArg, powerState, seedArg] = process.argv.slice(2);
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
const nodes = opt('nodes', null)?.split(',');
const fromS = Number(opt('from', raw.warmupTicks * dt));
const toS = Number(opt('to', raw.warmupTicks * dt + 5400));

const gates = [];
for (const cw of e.carriageways) for (const g of cw.gates) if (g.approach) gates.push({ g, lanes: () => e.carriagewayState.get(cw.id).lanes, name: `${cw.id}` });
for (const c of e.layout.connectors) for (const dirKey of ['fwd', 'rev']) for (const g of e.connectorDirs.get(c.id)[dirKey].gates) if (g.approach) gates.push({ g, lanes: () => e.connectorState.get(c.id)[dirKey].lanes, name: `${c.id}:${dirKey}` });
const watched = gates.filter(({ g }) => !nodes || nodes.includes(g.node.id));
const stats = new Map(watched.map((w) => [w, { crossed: 0, crossedQueued: 0, queuedS: 0, presentS: 0 }]));
const lastNear = new Map(); // car id -> watched gate it was last seen within reach of the line on
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
    const seen = new Map();
    for (const w of watched) {
        const st = stats.get(w);
        let queued = false;
        for (const lane of w.lanes()) {
            const before = lane.cars.filter((c) => c.distanceM <= w.g.stopLineDistanceM && w.g.stopLineDistanceM - c.distanceM < 40);
            for (const c of before) seen.set(c.id, w);
            const front = before.sort((a, b) => b.distanceM - a.distanceM)[0];
            if (front && w.g.stopLineDistanceM - front.distanceM < 12 && front.speedMps < 1 && before.length >= 2) queued = true;
        }
        if (queued) st.queuedS += dt;
        st.wasQueued = queued;
    }
    // A car that was near a watched line last tick and isn't now crossed it (drove on, or hopped onto a turn/ring path).
    for (const [id, w] of lastNear) {
        if (seen.get(id) === w) continue;
        const st = stats.get(w);
        st.crossed += 1;
        if (st.wasQueued || st.prevQueued) st.crossedQueued += 1;
    }
    for (const w of watched) stats.get(w).prevQueued = stats.get(w).wasQueued;
    lastNear.clear();
    for (const [id, w] of seen) lastNear.set(id, w);
}
const periodH = (toS - fromS) / 3600;
const rows = [...stats].map(([w, s]) => ({ node: w.g.node.id, control: w.g.node.control ?? 'signal', road: w.name, lanes: w.g.slotLaneUse?.length, flowPerH: s.crossed / periodH, queuedShare: s.queuedS / (toS - fromS), dischargePerH: s.queuedS > 60 ? (3600 * s.crossedQueued) / s.queuedS : null }));
rows.sort((a, b) => b.queuedShare - a.queuedShare);
console.log(`node                 control    approach                          lanes  flow/h  queued%  discharge-while-queued/h`);
for (const r of rows.slice(0, Number(opt('top', 30)))) console.log(`${r.node.padEnd(20)} ${r.control.padEnd(10)} ${r.road.padEnd(34)} ${String(r.lanes).padStart(4)} ${r.flowPerH.toFixed(0).padStart(7)} ${(100 * r.queuedShare).toFixed(0).padStart(7)}% ${r.dischargePerH == null ? '      -' : r.dischargePerH.toFixed(0).padStart(7)}`);
