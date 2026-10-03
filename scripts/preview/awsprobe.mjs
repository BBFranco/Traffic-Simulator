import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { carRenderPoint, carRenderHeading } from '../../resources/js/sim/car.js';
const layout = buildLayout(JSON.parse(readFileSync('corridors/hatfield-realistic.json', 'utf8')));
const engine = new SimulationEngine(layout);
const modes = {}, demand = {};
for (const a of layout.arterials) { modes[a.id] = 'fixed'; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand?.spawnRatePerLanePerMin ?? 0;
engine.reset({ seed: 9, arterialModes: modes, demand, sensorMode: 'camera', batteryBackedSensors: true, power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 } });
engine.setManualLoadShedding(true);
const allCars = () => [...engine.turningCars, ...[...engine.carriagewayState.values()].flatMap((s) => s.lanes.flatMap((l) => l.cars)), ...[...engine.connectorState.values()].flatMap((s) => ['fwd', 'rev'].flatMap((k) => (s[k]?.lanes ?? []).flatMap((l) => l.cars)))];
const aws = [...engine.nodesInfo.values()].filter((i) => i.controllerType === 'allWayStop').map((i) => i.node);
let overlaps = 0, overlapTicks = new Set();
for (let t = 0; t < 12000; t++) {
    engine.tick(0.1);
    if (t < 3000 || t % 5) continue;
    const pts = allCars().map((c) => ({ c, p: carRenderPoint(c), h: carRenderHeading(c) }));
    for (const n of aws) {
        const r = Math.min(n.crossRoadWidthM, n.arterialRoadWidthM) / 2;
        const inBox = pts.filter((q) => Math.hypot(q.p.x - n.point.x, q.p.y - n.point.y) < r);
        for (let i = 0; i < inBox.length; i++) for (let j = i + 1; j < inBox.length; j++) {
            const a = inBox[i], b = inBox[j];
            const d = Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y);
            const dot = Math.abs(a.h.x * b.h.x + a.h.y * b.h.y);
            if (d < 3 && dot < 0.85) { overlaps++; overlapTicks.add(`${n.id}@${t}`); }
        }
    }
}
console.log('aws nodes', aws.length, 'crossing overlaps (<3m, >30deg) sampled', overlaps);
console.log(engine.carAccounting());
