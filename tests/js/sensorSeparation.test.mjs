/**
 * Batch-level sensor guard: on the real corridor the four sensor variants must OBSERVE differently (per-tick detector
 * frames) and the estimator must decide differently. Final traffic outcomes are reported, not asserted - two variants
 * can legitimately end in the same metrics when different observations lead to the same controller decisions.
 * A short run, one seed: a smoke test, not proof of separation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadCorridor, startEngine } from '../../batch/trajectoryHash.mjs';

const SENSORS = ['inductive_loop', 'magnetometer', 'radar', 'camera'];
const TICKS = 1500;
const config = loadCorridor('hatfield-realistic');

function digestRun(sensorMode, controllerMode, sensorErrors = false) {
    const { engine } = startEngine({ config, seed: 1, controllerMode, sensorMode });
    engine.sensorErrors = sensorErrors;
    engine.setSensorMode(sensorMode);
    const observations = createHash('sha1');
    const decisions = createHash('sha1');
    const sample = engine._sampleDetectors.bind(engine);
    engine._sampleDetectors = (info, dt) => {
        const frames = sample(info, dt);
        observations.update(`${info.node.id}${JSON.stringify(frames)}`);
        return frames;
    };
    const estimate = engine._isOtherCallSufficient.bind(engine);
    engine._isOtherCallSufficient = (...args) => {
        const sufficient = estimate(...args);
        decisions.update(sufficient ? '1' : '0');
        return sufficient;
    };
    for (let t = 0; t < TICKS; t += 1) engine.tick(0.1);
    return {
        observations: observations.digest('hex'),
        decisions: decisions.digest('hex'),
        cleared: engine.accounting.totalClearedNetwork,
        sensorDraws: engine.sensorRngs.size,
    };
}

for (const controllerMode of ['adaptive', 'coordinated_adaptive']) {
    test(`${controllerMode}: every pair of sensors observes and decides differently`, (t) => {
        const runs = Object.fromEntries(SENSORS.map((mode) => [mode, digestRun(mode, controllerMode)]));
        for (let i = 0; i < SENSORS.length; i += 1) {
            for (let j = i + 1; j < SENSORS.length; j += 1) {
                const [a, b] = [SENSORS[i], SENSORS[j]];
                assert.notEqual(runs[a].observations, runs[b].observations, `${a} vs ${b} observations`);
                assert.notEqual(runs[a].decisions, runs[b].decisions, `${a} vs ${b} decisions`);
            }
        }
        // Errors off: no sensor noise stream is ever drawn.
        for (const mode of SENSORS) assert.equal(runs[mode].sensorDraws, 0, `${mode} drew sensor noise with errors off`);
        t.diagnostic(`vehicles cleared after ${TICKS} ticks: ${SENSORS.map((m) => `${m} ${runs[m].cleared}`).join(', ')}`);
    });
}

test('sensor errors on (sensitivity runs): radar draws its count noise from its own streams', () => {
    assert.ok(digestRun('radar', 'adaptive', true).sensorDraws > 0);
});
