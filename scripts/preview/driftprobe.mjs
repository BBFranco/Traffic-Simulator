// Where queues grow in a from-empty normal-power run (what the warm-up probe's "never settled" is made of): every
// <everyS>, the stood cars (v < 0.5) per road, the biggest roads first.
// node scripts/preview/driftprobe.mjs <controller> <sensor> <seed> [--routing=destination] [--minutes=120] [--every=600]
//   [--sim=<dir of an engine copy to run instead>]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [controller, sensor, seedArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const simDir = resolve(opt('sim', new URL('../../resources/js/sim', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')));
const { buildLayout } = await import(pathToFileURL(`${simDir}/corridor.js`));
const { SimulationEngine } = await import(pathToFileURL(`${simDir}/engine.js`));
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
const dt = 0.1;
const every = Math.round(Number(opt('every', 600)) / dt);
const end = Math.round(Number(opt('minutes', 120)) * 60 / dt);
for (let tick = 1; tick <= end; tick += 1) {
    e.tick(dt);
    if (tick % every) continue;
    const stood = new Map();
    let all = 0;
    for (const { car } of e.lockupWatch._liveCars()) {
        all += 1;
        if (car.speedMps >= 0.5) continue;
        const name = `${e._roadName(car.road)}${car.road.statsKey === 'side' ? '' : '*'}`;
        stood.set(name, (stood.get(name) ?? 0) + 1);
    }
    const top = [...stood].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([n, c]) => `${n} ${c}`).join(' | ');
    console.log(`${Math.round(tick * dt / 60)} min cars ${all} stood ${[...stood.values()].reduce((a, b) => a + b, 0)}: ${top}`);
}
