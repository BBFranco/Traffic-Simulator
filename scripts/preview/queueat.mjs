// Stood cars (v < 0.5) on the arterial-scope roads, by the stop line they queue for, every <everyS> - which approaches a
// growing arterial wait comes from. node scripts/preview/queueat.mjs <controller> <sensor> <seed> [--from=60] [--to=120]
//   [--every=300] [--routing=destination] [--top=12]   (minutes from empty)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [controller, sensor, seedArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const cfg = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
const layout = buildLayout(cfg);
const e = new SimulationEngine(layout);
const modes = {};
const demand = {};
for (const a of layout.arterials) { modes[a.id] = controller; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand.spawnRatePerLanePerMin;
e.reset({
    seed: Number(seedArg), arterialModes: modes, demand, sensorMode: sensor, batteryBackedSensors: true,
    power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: opt('routing', 'destination'),
});
const gatesByRoad = new Map();
for (const info of e.nodesInfo.values()) for (const gate of [...info.arterialGates, ...info.crossGates]) {
    const road = gate.carriageway?.road ?? gate.dir?.road;
    if (!road) continue;
    if (!gatesByRoad.has(road)) gatesByRoad.set(road, []);
    gatesByRoad.get(road).push(gate);
}
for (const gates of gatesByRoad.values()) gates.sort((a, b) => a.stopLineDistanceM - b.stopLineDistanceM);
const from = Number(opt('from', 60)) * 600;
const to = Number(opt('to', 120)) * 600;
const every = Number(opt('every', 300)) * 10;
for (let tick = 1; tick <= to; tick += 1) {
    e.tick(0.1);
    if (tick < from || tick % every) continue;
    const at = new Map();
    for (const { car } of e.lockupWatch._liveCars()) {
        if (car.turnPath || car.speedMps >= 0.5 || car.road.statsKey === 'side') continue;
        const gate = (gatesByRoad.get(car.road) ?? []).find((g) => g.stopLineDistanceM >= car.distanceM - 1);
        const key = `${e._roadName(car.road)} -> ${gate ? gate.node.id : 'end'}`;
        const entry = at.get(key) ?? { n: 0, back: 0 };
        entry.n += 1;
        if (gate) entry.back = Math.max(entry.back, gate.stopLineDistanceM - car.distanceM);
        at.set(key, entry);
    }
    const top = [...at].sort((a, b) => b[1].n - a[1].n).slice(0, Number(opt('top', 12)));
    console.log(`\n${tick / 600} min: ${top.map(([k, v]) => `${k} ${v.n} (${Math.round(v.back)} m)`).join(' | ')}`);
}
