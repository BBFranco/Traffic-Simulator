// Routed design flow (what fixed-time / green-wave Webster timing is given in destination mode) vs the flow that
// actually crosses each signalised approach's stop line, by movement, over a from-empty normal-power run.
// node scripts/preview/flowcheck.mjs <controller> <sensor> <seed> [--from=30] [--to=120] (minutes)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [controller, sensor, seedArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const fromT = Number(opt('from', 30)) * 600;
const toT = Number(opt('to', 120)) * 600;
const cfg = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
const layout = buildLayout(cfg);
const e = new SimulationEngine(layout);
const modes = {};
const demand = {};
for (const a of layout.arterials) { modes[a.id] = controller; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand.spawnRatePerLanePerMin;
e.reset({
    seed: Number(seedArg), arterialModes: modes, demand, sensorMode: sensor, batteryBackedSensors: true,
    power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: 'destination',
});

const gatesByRoad = new Map();
const signalGates = [];
for (const info of e.nodesInfo.values()) {
    if (info.node.control && info.node.control !== 'signal') continue;
    for (const gate of [...info.arterialGates, ...info.crossGates]) {
        const road = gate.carriageway?.road ?? gate.dir?.road;
        if (!road) continue;
        if (!gatesByRoad.has(road)) gatesByRoad.set(road, []);
        gatesByRoad.get(road).push(gate);
        signalGates.push({ gate, road, info, counts: { straight: 0, left: 0, right: 0 } });
    }
}
const entryOf = new Map(signalGates.map((g) => [g.gate, g]));
// Saturated discharge: successive crossings of the same lane and movement less than HEADWAY_MAX_S apart, i.e. a queue
// moving off on green - their mean headway is that movement's saturation flow (3600 / h veh/h).
const HEADWAY_MAX_S = 4;
const headways = new Map(); // `${movement}` -> { sum, n }
let tickNow = 0;
const stoppedOn = new Map(); // car id -> the road it last stood on (queued at a stop line)
const count = (gate, movement, lane, carId) => {
    const g = entryOf.get(gate);
    if (!g) return;
    g.counts[movement] += 1;
    g.last ??= {};
    const key = `${lane}:${movement}`;
    const t = tickNow * 0.1;
    const queued = stoppedOn.get(carId) === gate.carriageway?.road || stoppedOn.get(carId) === gate.dir?.road;
    const prevQueued = g.lastQueued?.[key];
    const h = g.last[key] != null ? t - g.last[key] : Infinity;
    g.last[key] = t;
    (g.lastQueued ??= {})[key] = queued;
    if (h > HEADWAY_MAX_S || !queued || !prevQueued) return;
    for (const k of [movement, `${gate.connector ? 'cross' : 'arterial'}:${movement}`]) {
        const e = headways.get(k) ?? { sum: 0, n: 0 };
        e.sum += h; e.n += 1; headways.set(k, e);
    }
    g.sat ??= {};
    const e = (g.sat[movement] ??= { sum: 0, n: 0 });
    e.sum += h; e.n += 1;
};
let prev = new Map();
for (let tick = 1; tick <= toT; tick += 1) {
    e.tick(0.1);
    tickNow = tick;
    if (tick < fromT) continue;
    const now = new Map();
    for (const { car } of e.lockupWatch._liveCars()) {
        now.set(car.id, { road: car.road, d: car.distanceM, lane: car.lane, turning: Boolean(car.turnPath) });
        if (!car.turnPath && car.speedMps < 0.5) stoppedOn.set(car.id, car.road);
        const p = prev.get(car.id);
        if (!p) continue;
        if (p.turning) continue;
        if (car.turnPath) {
            // Just started a turn (or straight across a box): at the gate it was pulling up to on the road it was on.
            let best = null;
            for (const gate of gatesByRoad.get(p.road) ?? []) if (Math.abs(p.d - gate.stopLineDistanceM) < 8 && (!best || Math.abs(p.d - gate.stopLineDistanceM) < Math.abs(p.d - best.stopLineDistanceM))) best = gate;
            if (best) count(best, car.turnPath.movement ?? 'straight', p.lane, car.id);
        } else if (p.road === car.road) {
            for (const gate of gatesByRoad.get(car.road) ?? []) if (p.d < gate.stopLineDistanceM && car.distanceM >= gate.stopLineDistanceM) count(gate, 'straight', p.lane, car.id);
        }
    }
    prev = now;
}
const minutes = (toT - fromT) / 600;
const rows = [];
for (const g of signalGates) {
    const model = e.routingModel.movementFlowByGate.get(g.gate) ?? { straight: 0, left: 0, right: 0, total: 0 };
    const m = Object.fromEntries(Object.entries(g.counts).map(([k, v]) => [k, v / minutes]));
    m.total = m.straight + m.left + m.right;
    rows.push({ node: g.info.node.id, road: e._roadName(g.road), model, m, sat: Object.fromEntries(Object.entries(g.sat ?? {}).map(([k, v]) => [k, { n: v.n, vph: Math.round(3600 / (v.sum / v.n)) }])) });
}
console.log(JSON.stringify({ rows: rows.map((r) => ({ node: r.node, road: r.road, model: r.model, measured: r.m, sat: r.sat })), saturation: Object.fromEntries([...headways].map(([k, v]) => [k, { n: v.n, vph: Math.round(3600 / (v.sum / v.n)) }])) }));
