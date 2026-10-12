// Missed turns of one batch-shaped normal-power run, split by junction control and by junction - which junctions the
// wrong-lane misses come from. node scripts/preview/missedsplit.mjs <controller> <sensor> <seed> [--routing=destination]
//   [--warm=36000] [--sim=<dir of an engine copy to run instead>]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [controller, sensor, seedArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const simDir = resolve(opt('sim', new URL('../../resources/js/sim', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')));
const { buildLayout } = await import(pathToFileURL(`${simDir}/corridor.js`));
const { SimulationEngine } = await import(pathToFileURL(`${simDir}/engine.js`));
const warm = Number(opt('warm', 36000));
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
for (let tick = 0; tick < warm + 36000; tick += 1) {
    if (tick === warm) e.resetStats();
    e.tick(0.1);
}
const { missedAt, missedBy, missedTurns } = e.routingStats;
const byType = {};
const byNode = {};
for (const [key, n] of Object.entries(missedAt)) {
    const nodeId = key.split(':')[0];
    const type = e.nodesInfo.get(nodeId)?.controllerType ?? 'other';
    const kind = type === 'roundabout' ? 'roundabout' : ['allWayStop', 'stop'].includes(type) ? type : 'signal';
    byType[kind] = (byType[kind] ?? 0) + n;
    byNode[key] = n;
}
const top = Object.entries(byNode).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ');
console.log(JSON.stringify({ seed: seedArg, missedTurns, missedBy, byType }), `\n  top: ${top}`);
