// How often each let-in kind holds a lane in one batch-shaped run: a merge's, a turner's within LET_IN_HOLD_S, and a
// turner's kept on past it because it is still held through its red.
// node scripts/preview/letincount.mjs <controller> <sensor> <seed> [--routing=random] [--warm=36000]
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const counts = { withinHold: 0, keptThroughRed: 0, asks: new Set(), merges: new Set() };
const active = SimulationEngine.prototype._letInActive;
SimulationEngine.prototype._letInActive = function (waiting) {
    const out = active.call(this, waiting);
    if (out) counts[waiting.untilS >= this.simTimeS ? 'withinHold' : 'keptThroughRed'] += 1;
    return out;
};
const ask = SimulationEngine.prototype._askToBeLetIn;
SimulationEngine.prototype._askToBeLetIn = function (car, road, laneIndex, exitDistanceM, heldPlan = null) {
    (car.joinHeldSinceS != null && !heldPlan ? counts.merges : counts.asks).add(car.id);
    return ask.call(this, car, road, laneIndex, exitDistanceM, heldPlan);
};

const [controllerMode, sensorMode, seedArg] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const corridorConfig = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
const { summary } = runHeadless({
    seed: Number(seedArg), controllerMode, sensorMode, routingMode: opt('routing', 'random'), corridorConfig,
    warmupTicks: Number(opt('warm', 36000)), durationTicks: 36000, powerOutageStartTick: 9000, powerOutageEndTick: 18000, sampleEverySeconds: 10,
});
console.log(JSON.stringify({ run: `${controllerMode}/${sensorMode}/${seedArg}`, maxWait: summary.maxWait?.toFixed(0), longestStillS: Math.round(summary.diagnostics.lockup.longestStillS),
    holdTicksWithinHold: counts.withinHold, holdTicksKeptThroughRed: counts.keptThroughRed, turnersAsking: counts.asks.size, mergersAsking: counts.merges.size }));
