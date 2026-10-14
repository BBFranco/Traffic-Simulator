// Load-shedding run under destination routing: throughput per segment split into pull-offs (trips ending in a
// driveway) and map exits, to see what keeps clearing while the lights are dark.
// node scripts/preview/splitprobe.mjs <config.json> <controller> <sensor> <seed> [--warm=36000] [--duration=36000]
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controller, sensor, seedArg] = process.argv.slice(2);
const opt = (name, fallback) => Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const warm = opt('warm', 36000);
const duration = opt('duration', 36000);
const dt = 0.1;

const cfg = JSON.parse(readFileSync(path, 'utf8'));
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

const marks = [];
const mark = (label) => {
    const s = e.routingStats;
    marks.push({ label, t: e.simTimeS, pulledOff: s.pulledOff, toExit: s.toExit, cleared: e.totalStats.clearedTotal, side: e.sideStreetStats.clearedTotal });
};
const bounds = { 0: 'start', [duration / 4]: 'outage', [duration / 2]: 'restored', [duration]: 'end' };
for (let tick = 0; tick <= warm + duration; tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (bounds[m] != null) mark(bounds[m]);
    if (tick === warm + duration) break;
    if (m === duration / 4) e.setManualLoadShedding(true);
    if (m === duration / 2) e.setManualLoadShedding(false);
    e.tick(dt);
}
for (let i = 1; i < marks.length; i += 1) {
    const a = marks[i - 1];
    const b = marks[i];
    const min = (b.t - a.t) / 60;
    const rate = (k) => ((b[k] - a[k]) / min).toFixed(1);
    console.log(`${a.label}->${b.label}: cleared ${rate('cleared')}/min = pull-offs ${rate('pulledOff')} + exits ${rate('toExit')} (+ untracked ${((b.cleared - a.cleared - (b.pulledOff - a.pulledOff) - (b.toExit - a.toExit)) / min).toFixed(1)}); side-street bucket ${rate('side')}/min`);
}
