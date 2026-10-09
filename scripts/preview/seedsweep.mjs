// A few full batch-shaped runs (60 min warm-up + 60 min measured) to spot gridlocks: per seed, mean/max wait,
// throughput, lost arrivals and roundabout overruns.
// node scripts/preview/seedsweep.mjs <config.json> <controller> <sensor> <seed,seed,...> [--outage] [--routing=destination]
//   [--warm=36000] [--pre-fix]   restores the 2026-10-08 roundabout leaders (before the ring-exit deadlock fix), to check the lockup watch catches it
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

if (process.argv.includes('--pre-fix')) {
    const ringLeader = SimulationEngine.prototype._ringLeader;
    SimulationEngine.prototype._ringLeader = function (car, ring) {
        const { ringExitAtM } = car.turnPath;
        car.turnPath.ringExitAtM = Infinity;
        try { return ringLeader.call(this, car, ring); } finally { car.turnPath.ringExitAtM = ringExitAtM; }
    };
    SimulationEngine.prototype._sameWayLeader = (car, leader) => leader;
}

const [path, controllerMode, sensorMode, seeds] = process.argv.slice(2);
const outage = process.argv.includes('--outage');
const routingMode = process.argv.find((a) => a.startsWith('--routing='))?.split('=')[1] ?? 'destination';
const warmupTicks = Number(process.argv.find((a) => a.startsWith('--warm='))?.split('=')[1] ?? 36000);
const corridorConfig = JSON.parse(readFileSync(path, 'utf8'));
for (const seed of seeds.split(',').map(Number)) {
    const { summary } = runHeadless({
        seed, controllerMode, sensorMode, corridorConfig, routingMode,
        warmupTicks, durationTicks: 36000,
        powerOutageStartTick: outage ? 9000 : null, powerOutageEndTick: outage ? 18000 : null,
        sampleEverySeconds: 10,
    });
    console.log(`${controllerMode}/${sensorMode} ${outage ? 'LS' : 'normal'} seed ${seed}: wait ${summary.avgWaitTime.toFixed(1)} max ${summary.maxWait.toFixed(0)} thr ${summary.throughputPerMin.toFixed(1)} lost ${summary.diagnostics.arrivalsLost} overruns ${summary.diagnostics.roundaboutOverruns}`);
    console.log(`    lockup ${JSON.stringify(summary.diagnostics.lockup)}`);
}
