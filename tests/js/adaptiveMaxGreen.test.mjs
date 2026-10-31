/**
 * The adaptive maximum-green sensitivity (plan Phase 4 item 6): the controller honours per-stage maxima, without them it
 * keeps the usual 45 s / 25 s x weight, and a 'sartsm' run caps only the junctions whose usual maxima exceed a 120 s
 * cycle. The default run is guarded byte for byte by trajectoryHash.test.mjs and summaryIdentity.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveController } from '../../resources/js/sim/controllers/adaptive.js';
import { LOST_TIME_PER_PHASE_S, MAX_CYCLE_S } from '../../resources/js/sim/controllers/phasePlan.js';
import { ADAPTIVE_DEFAULTS } from '../../resources/js/sim/equations.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { loadCorridor } from '../../batch/trajectoryHash.mjs';

/** Seconds of green the current stage got: ticks it at 0.1 s with constant detections and a call waiting. */
function greenLength(controller) {
    let elapsed = 0;
    while (controller.phaseState === 'green' && elapsed < 200) {
        controller.tick(0.1, true, true, [true, true]);
        elapsed += 0.1;
    }
    return elapsed;
}

test('the usual maxima without overrides: 45 s through, 25 s x weight turn', () => {
    const controller = new AdaptiveController(undefined, [2, null]);
    assert.equal(controller.maxGreenFor(0, false), ADAPTIVE_DEFAULTS.maxGreen);
    assert.equal(controller.maxGreenFor(1, false), 45);
    assert.equal(controller.maxGreenFor(0, true), 50);
    assert.ok(Math.abs(greenLength(controller) - 45) < 0.15);
});

test('per-stage overrides cap the through green and the turn arrow', () => {
    const controller = new AdaptiveController(undefined, [1, null], { through: [30, 20], turn: [12, null] });
    assert.ok(Math.abs(greenLength(controller) - 30) < 0.15, 'arterial through');
    while (controller.phaseState !== 'green') controller.tick(0.1, false, true, [true, true]);
    assert.equal(controller.phase, 1);
    assert.ok(Math.abs(greenLength(controller) - 20) < 0.15, 'cross through');
    while (controller.phaseState !== 'green') controller.tick(0.1, false, true, [true, true]);
    assert.ok(controller.inTurn, 'arterial turn arrow');
    assert.ok(Math.abs(greenLength(controller) - 12) < 0.15, 'arterial turn');
});

/** A short adaptive run on the Hatfield network, handing back its engine and summary. */
function adaptiveRun(adaptiveMaxGreen) {
    let engine = null;
    const tick = SimulationEngine.prototype.tick;
    SimulationEngine.prototype.tick = function (dt) {
        engine = this;
        return tick.call(this, dt);
    };
    try {
        const { summary } = runHeadless({ seed: 1, controllerMode: 'adaptive', sensorMode: 'inductive_loop', corridorConfig: loadCorridor('hatfield-realistic'), durationTicks: 300, routingMode: 'destination', adaptiveMaxGreen });
        return { engine, summary };
    } finally {
        SimulationEngine.prototype.tick = tick;
    }
}

test("'sartsm' caps only the junctions whose usual maxima exceed a 120 s cycle, and says so in the run's config", () => {
    const { engine, summary } = adaptiveRun('sartsm');
    assert.equal(summary.rawConfig.controllerConfig.adaptiveMaxGreen, 'sartsm-webster-c120');
    const adaptive = [...engine.nodesInfo.values()].filter((info) => info.controllerType === 'adaptive');
    let capped = 0;
    for (const info of adaptive) {
        const c = info.controller;
        const stages = [0, 1].flatMap((phase) => [c.turnWeights[phase] != null ? c.maxGreenFor(phase, true) : null, c.maxGreenFor(phase, false)]).filter((g) => g != null);
        const usualS = [0, 1].reduce((sum, phase) => sum + 45 + (c.turnWeights[phase] != null ? 25 * c.turnWeights[phase] : 0), 0);
        const lostS = stages.length * LOST_TIME_PER_PHASE_S;
        if (usualS + lostS <= MAX_CYCLE_S) {
            assert.deepEqual([c.maxGreenFor(0, false), c.maxGreenFor(1, false)], [45, 45], `${info.node.id} keeps 45 s`);
            continue;
        }
        capped += 1;
        const totalS = stages.reduce((sum, g) => sum + g, 0) + lostS;
        assert.ok(totalS <= MAX_CYCLE_S + 1e-6, `${info.node.id}: ${totalS} s`);
        for (const phase of [0, 1]) {
            assert.ok(c.maxGreenFor(phase, false) <= 45, `${info.node.id} through never above 45 s`);
            if (c.turnWeights[phase] != null) assert.ok(c.maxGreenFor(phase, true) <= 25 * c.turnWeights[phase] + 1e-9, `${info.node.id} turn never above 25 s x weight`);
        }
    }
    assert.ok(capped > 0, 'the turn-arrow junctions are capped');
    assert.ok(adaptive.length > capped, 'two-stage junctions are not');
});

test("'default' is the run without the option", () => {
    const { engine, summary } = adaptiveRun('default');
    assert.equal(summary.rawConfig.controllerConfig.adaptiveMaxGreen, undefined);
    assert.ok([...engine.nodesInfo.values()].filter((i) => i.controllerType === 'adaptive').every((i) => i.controller.maxGreens === null));
});
