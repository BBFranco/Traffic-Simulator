/**
 * The time-of-day plan sensitivity: fixed-time signals re-timed on the hour for that hour's evening demand
 * (engine.js's setFixedPlanScale(), runHeadless.js's fixedTimeOfDay). The default run - one peak plan all evening - is
 * guarded byte for byte by trajectoryHash.test.mjs and summaryIdentity.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { EVENING_PROFILE } from '../../resources/js/sim/demandProfile.js';
import { LONG_PROTOCOL } from '../../resources/js/sim/batchSchedule.js';
import { loadCorridor } from '../../batch/trajectoryHash.mjs';

/** A short fixed-time run on the Hatfield network, handing back its engine and summary. */
function fixedRun(fixedTimeOfDay) {
    let engine = null;
    const tick = SimulationEngine.prototype.tick;
    SimulationEngine.prototype.tick = function (dt) {
        engine = this;
        return tick.call(this, dt);
    };
    try {
        const { summary } = runHeadless({
            seed: 1, controllerMode: 'fixed', corridorConfig: loadCorridor('hatfield-realistic'), durationTicks: 300, routingMode: 'destination',
            demandProfile: { profile: EVENING_PROFILE, startClockS: LONG_PROTOCOL.startClockS }, fixedTimeOfDay,
        });
        return { engine, summary };
    } finally {
        SimulationEngine.prototype.tick = tick;
    }
}

const cycles = (engine) => [...engine.nodesInfo.values()].filter((i) => i.controllerType === 'fixed').map((i) => i.controller.cycleLengthS);

test("a time-of-day run at 16:15 times its plans for the 16:00 hour (6.0 / 8.9 of the peak) and says so in its config", () => {
    const peak = fixedRun(false);
    const tod = fixedRun(true);
    assert.equal(tod.summary.rawConfig.controllerConfig.fixedTimeOfDay, 'hourly-evening-profile');
    assert.equal(peak.summary.rawConfig.controllerConfig.fixedTimeOfDay, undefined);
    assert.equal(tod.engine.fixedPlanScale, 6.0 / 8.9);
    const [p, t] = [cycles(peak.engine), cycles(tod.engine)];
    assert.equal(p.length, t.length);
    p.forEach((c, i) => assert.ok(t[i] <= c + 1e-9, `cycle ${i}: ${t[i]} > ${c}`));
    assert.ok(t.some((c, i) => c < p[i] - 1), 'lighter demand shortens some cycles');
    assert.ok(t.every((c) => c >= 30 - 1e-9), 'never below the SARTSM 30 s minimum');
});

test('scale 1 restores the peak plans exactly', () => {
    const { engine } = fixedRun(true);
    const tod = cycles(engine);
    engine.setFixedPlanScale(1);
    assert.deepEqual(cycles(engine), cycles(fixedRun(false).engine));
    assert.notDeepEqual(tod, cycles(engine));
});
