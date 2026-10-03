// Prints each signalled junction's fixed-time plan: Y, cycle, stage greens - node scripts/preview/planprobe.mjs <config.json> [--no-turns]
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { buildStages, stageRatios } from '../../resources/js/sim/controllers/phasePlan.js';
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (process.argv.includes('--no-turns')) for (const a of cfg.arterials) for (const n of a.intersections) delete n.turnPhases;
const layout = buildLayout(cfg);
const e = new SimulationEngine(layout);
const modes = {}, demand = {};
for (const a of layout.arterials) { modes[a.id] = 'fixed'; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand?.spawnRatePerLanePerMin ?? 0;
e.reset({ seed: 1, arterialModes: modes, demand, sensorMode: 'camera', batteryBackedSensors: true, power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 } });
let n = 0, sumC = 0, over = 0;
for (const info of e.nodesInfo.values()) {
    if (info.controllerType !== 'fixed') continue;
    const turn = e._turnStagesAt(info);
    const stages = buildStages(turn);
    const ys = stageRatios(stages, e._arterialDemandAt(info.node), e._crossDemandFor(info.node), turn);
    const Y = ys.reduce((s, y) => s + y, 0);
    const c = info.controller;
    n++; sumC += c.cycleLengthS; if (Y >= 1) over++;
    console.log(info.node.id.padEnd(22), 'Y', Y.toFixed(2), Y >= 1 ? 'FALLBACK' : '        ', 'cycle', c.cycleLengthS.toFixed(0).padStart(4), 'stages', stages.map((s, i) => `${s.turn ? 'T' : ''}${s.phase}:${c.stageGreens[i].toFixed(0)}(y${ys[i].toFixed(2)})`).join(' '));
}
console.log(`signals ${n}, mean cycle ${(sumC / n).toFixed(1)} s, Y>=1 (fallback 120 s cycle): ${over}`);
