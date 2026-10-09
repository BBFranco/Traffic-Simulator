// The lockup watch's waits-on chain from every car stood >= 300 s, at chosen moments - to see why it reads locked or
// starved. node scripts/preview/chainprobe.mjs <config.json> <controller> <sensor> <seed> <atS,atS,...> [--outage]
//   [--routing=random] [--warm=36000]   (atS: measured-window seconds)
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { LOCKUP_STILL_S } from '../../resources/js/sim/lockupWatch.js';

const [path, controller, sensor, seedArg, atList] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warm = Number(opt('warm', 36000));
const outage = process.argv.includes('--outage');
const dt = 0.1;
const ats = atList.split(',').map((s) => Math.round(Number(s) / dt));

const cfg = JSON.parse(readFileSync(path, 'utf8'));
const layout = buildLayout(cfg);
const e = new SimulationEngine(layout);
const modes = {};
const demand = {};
for (const a of layout.arterials) { modes[a.id] = controller; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand.spawnRatePerLanePerMin;
e.reset({
    seed: Number(seedArg), arterialModes: modes, demand, sensorMode: sensor, batteryBackedSensors: true,
    power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: opt('routing', 'random'),
});

for (let tick = 0; tick <= warm + Math.max(...ats); tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (outage && m === 9000) e.setManualLoadShedding(true);
    if (outage && m === 18000) e.setManualLoadShedding(false);
    e.tick(dt);
    if (!ats.includes(m)) continue;
    const watch = e.lockupWatch;
    const now = e.simTimeS;
    const stillS = (car) => now - (watch.stillSinceS.get(car.id) ?? now);
    const cars = watch._liveCars();
    const waitsOn = new Map(cars.map((entry) => [entry.car, entry.waitsOn]));
    console.log(`\n== measured ${(m * dt).toFixed(0)} s  power ${e.snapshot().powerState}`);
    for (const { car } of cars) {
        if (stillS(car) < LOCKUP_STILL_S) continue;
        const chain = [];
        const seen = new Set();
        for (let at = car; at && !seen.has(at) && chain.length < 40; at = waitsOn.get(at)) {
            seen.add(at);
            const d = watch._describe(at);
            chain.push(`${at.id} [${d.place}] still ${stillS(at).toFixed(0)} s v ${at.speedMps.toFixed(2)}`);
        }
        console.log(`  from ${car.id}:\n    ${chain.join('\n    -> ')}`);
    }
}
