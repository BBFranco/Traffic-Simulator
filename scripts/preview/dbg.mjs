import { readFileSync } from 'node:fs';
import { buildLayout, roadPointAt, leftNormal } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { lanePoint } from '../../resources/js/sim/car.js';
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const layout = buildLayout(cfg); const engine = new SimulationEngine(layout);
const exitDir = engine.carriagewaysById.get('duxbury');
const road = exitDir.road;
console.log('road', { w: road.roadWidthM, lanes: road.lanes, lw: road.laneWidthM, ks: road.kerbSlots, lk: exitDir.laneLayout.kerbSlots, heading: road.heading });
const d = 150;
const c = roadPointAt(road, d);
const n = leftNormal(c.heading);
for (let lane = 0; lane < 3; lane++) { const p = lanePoint(road, lane, d).point; console.log('lane', lane, 'offset from ref', ((p.x - c.point.x) * n.x + (p.y - c.point.y) * n.y).toFixed(2)); }
const A = cfg.arterials.find((a) => a.id === 'duxbury');
console.log('arterial', { lanes: A.lanes, median: A.medianWidthM, twoWay: !A.oneWay });
