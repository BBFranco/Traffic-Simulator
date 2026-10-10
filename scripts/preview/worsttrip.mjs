// The longest-waiting trips of one batch-shaped run: where each one's wait built up (per road scope key).
// node scripts/preview/worsttrip.mjs <controller> <sensor> <seed> [--normal] [--routing=random] [--warm=36000] [--top=5]
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const trips = [];
const record = SimulationEngine.prototype._recordVehicleClear;
SimulationEngine.prototype._recordVehicleClear = function (car) {
    trips.push({ id: car.id, waitS: car.totalWaitS, clearedAtS: this.simTimeS, byKey: [...(car.waitByKey ?? [])].filter(([, s]) => s > 1).sort((a, b) => b[1] - a[1]).slice(0, 4) });
    return record.call(this, car);
};

const [controllerMode, sensorMode, seedArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const outage = !process.argv.includes('--normal');
const corridorConfig = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
runHeadless({
    seed: Number(seedArg), controllerMode, sensorMode, routingMode: opt('routing', 'random'), corridorConfig,
    warmupTicks: Number(opt('warm', 36000)), durationTicks: 36000, sampleEverySeconds: 10,
    ...(outage ? { powerOutageStartTick: 9000, powerOutageEndTick: 18000 } : {}),
});
const warmS = Number(opt('warm', 36000)) / 10;
for (const t of trips.sort((a, b) => b.waitS - a.waitS).slice(0, Number(opt('top', 5)))) {
    console.log(`car ${t.id} waited ${t.waitS.toFixed(0)} s, cleared at measured ${(t.clearedAtS - warmS).toFixed(0)} s: ${t.byKey.map(([k, s]) => `${k} ${s.toFixed(0)} s`).join(', ')}`);
}
