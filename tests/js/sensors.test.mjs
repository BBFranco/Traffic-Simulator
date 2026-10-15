/**
 * Sensor observation models (sensorSpecs.js, sensors.js) and the common demand estimator (demandEstimator.js).
 * Observable differences are asserted only where the declared models predict them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeDetector } from '../../resources/js/sim/sensors.js';
import { SENSOR_SPEC_SETS, latencyTicks, sensorSpecFor, sensorSpecHash } from '../../resources/js/sim/sensorSpecs.js';
import { isOtherCallSufficient } from '../../resources/js/sim/demandEstimator.js';
import { ADAPTIVE_DEFAULTS } from '../../resources/js/sim/equations.js';

const STOP_LINE_M = 200;
const SENSORS = ['inductive_loop', 'magnetometer', 'radar', 'camera'];
const car = (upstreamM, { stopped = false, speedMps = stopped ? 0 : 12, lengthM = 4.5 } = {}) => ({ distanceM: STOP_LINE_M - upstreamM, stoppedNow: stopped, speedMps, lengthM });
const observe = (mode, cars) => observeDetector(sensorSpecFor(mode, 'field'), cars, STOP_LINE_M);
const observeAll = (cars) => Object.fromEntries(SENSORS.map((mode) => [mode, observe(mode, cars)]));

/** Where the sim's first car actually stands: front ~4.3 m behind the line. */
const QUEUE_OF_3 = [car(4.3, { stopped: true }), car(11.3, { stopped: true }), car(18.3, { stopped: true })];

test('a car still approaching 30 m out: only the magnetometer advance puck actuates; radar and camera see it move', () => {
    const o = observeAll([car(30)]);
    assert.equal(o.inductive_loop.actuated, false);
    assert.equal(o.magnetometer.actuated, true);
    assert.equal(o.radar.actuated, false);
    assert.equal(o.camera.actuated, false);
    assert.equal(o.radar.speedMps, 12);
    assert.equal(o.camera.speedMps, 12);
    assert.equal(o.inductive_loop.speedMps, null);
    assert.equal(o.magnetometer.speedMps, null);
    // Moving, so nobody counts it as queued or reports the queue reaching the puck.
    assert.equal(o.radar.count, 0);
    assert.equal(o.magnetometer.queueExtent, false);
});

test('a car rolling over the stop-line zone: everyone actuates; the presence sensors place a call, the counting sensors do not count it', () => {
    const o = observeAll([car(5)]);
    for (const mode of SENSORS) assert.equal(o[mode].actuated, true, mode);
    assert.equal(o.inductive_loop.presence, true);
    assert.equal(o.magnetometer.presence, true);
    assert.equal(o.radar.presence, false);
    assert.equal(o.camera.presence, false);
});

test('a 3-car queue: the loop and the magnetometer report presence only, radar and camera count all three', () => {
    const o = observeAll(QUEUE_OF_3);
    for (const mode of SENSORS) assert.equal(o[mode].presence, true, mode);
    assert.equal(o.inductive_loop.count, null);
    assert.equal(o.magnetometer.count, null);
    assert.equal(o.radar.count, 3);
    assert.equal(o.camera.count, 3);
    assert.equal(o.magnetometer.queueExtent, false); // 18 m of queue doesn't reach the 30 m puck
    assert.equal(o.inductive_loop.queueExtent, null);
});

test('a queue standing back over 30 m: the magnetometer reports its extent', () => {
    const queue = [4.3, 11.3, 18.3, 25.3, 32.3].map((u) => car(u, { stopped: true }));
    assert.equal(observe('magnetometer', queue).queueExtent, true);
});

test('a vehicle standing 90 m back is inside the camera\'s 120 m region but beyond the radar\'s 60 m window', () => {
    const o = observeAll([car(90, { stopped: true })]);
    assert.equal(o.camera.count, 1);
    assert.equal(o.radar.count, 0);
});

test('the loop and the magnetometer pucks see a vehicle by its body: a truck whose front is past the line still occupies the zone', () => {
    const truck = car(-3, { stopped: true, lengthM: 12 });
    assert.equal(observe('inductive_loop', [truck]).presence, true);
    assert.equal(observeDetector(sensorSpecFor('inductive_loop', 'legacy'), [truck], STOP_LINE_M).presence, false);
});

test('latency rounds up to whole 0.1 s ticks: loop 1, magnetometer 2, radar 2, camera 1; legacy none', () => {
    const ticks = Object.fromEntries(SENSORS.map((mode) => [mode, latencyTicks(sensorSpecFor(mode, 'field'), 0.1)]));
    assert.deepEqual(ticks, { inductive_loop: 1, magnetometer: 2, radar: 2, camera: 1 });
    for (const mode of SENSORS) assert.equal(latencyTicks(sensorSpecFor(mode, 'legacy'), 0.1), 0);
});

test('evidence rule: every field-spec number carries a source or an assumed/derived tag', () => {
    const tagged = (text) => typeof text === 'string' && (/https?:\/\//.test(text) || /assumed|derived|as cited/.test(text));
    for (const mode of SENSORS) {
        const spec = SENSOR_SPEC_SETS.field[mode];
        assert.ok(tagged(spec.gapOut.source), `${mode} gapOut`);
        assert.ok(tagged(spec.call.source), `${mode} call zone`);
        for (const zone of spec.advance) assert.ok(tagged(zone.source), `${mode} advance zone`);
        if (spec.latency.ms) assert.ok(tagged(spec.latency.source), `${mode} latency`);
        if (spec.samplePeriodS != null) assert.ok(tagged(spec.samplePeriodSource), `${mode} sample period`);
        if (spec.outputs.count?.filter) assert.ok(tagged(spec.outputs.count.filter.source), `${mode} count filter`);
        if (spec.errors.countNoise) assert.ok(tagged(spec.errors.countNoise.source), `${mode} count noise`);
    }
});

test('field errors default to zero: no miss / false-call / crosstalk, and count noise only when a run switches errors on', () => {
    for (const mode of SENSORS) {
        const spec = SENSOR_SPEC_SETS.field[mode];
        assert.equal(spec.errors.missP, 0);
        assert.equal(spec.errors.falseCallP, 0);
        assert.equal(spec.errors.crosstalkP, 0);
        assert.ok(!spec.errorsAlwaysOn, mode);
    }
});

test('every sensor shares one gap-out zone: 0-8 m upstream of the line', () => {
    for (const set of ['field', 'legacy']) {
        for (const mode of SENSORS) assert.deepEqual([SENSOR_SPEC_SETS[set][mode].gapOut.startM, SENSOR_SPEC_SETS[set][mode].gapOut.lengthM], [0, 8], `${set} ${mode}`);
    }
});

/** Runs the estimator for `ticks` ticks on the same frame and returns the first tick it says yes (or null). */
function ticksUntilCall(outputs, frame, ticks = 200, dt = 0.1) {
    const state = { callPersistenceS: [0, 0], countSamples: [[], []] };
    for (let t = 1; t <= ticks; t += 1) {
        if (isOtherCallSufficient({ state, currentPhase: 0, frames: [frame], readCount: (f) => f.count, outputs, params: ADAPTIVE_DEFAULTS, dt, simTimeS: t * dt })) return t;
    }
    return null;
}

test('the estimator decides on what a frame carries, not on which sensor: identical outputs give identical decisions', () => {
    const presenceOnly = { presence: true, count: null, queueExtent: null };
    assert.equal(ticksUntilCall(SENSOR_SPEC_SETS.field.inductive_loop.outputs, presenceOnly), ticksUntilCall({ ...SENSOR_SPEC_SETS.field.magnetometer.outputs, queueExtent: false }, presenceOnly));
});

test('estimator: presence-only waits out the debounce; a queue over an advance zone calls at once', () => {
    const outputs = SENSOR_SPEC_SETS.field.magnetometer.outputs;
    assert.equal(ticksUntilCall(outputs, { presence: true, count: null, queueExtent: false }), 30);
    assert.equal(ticksUntilCall(outputs, { presence: true, count: null, queueExtent: true }), 1);
});

test('estimator: a count at the threshold calls at once unfiltered, after the window when smoothed, and a short queue after maxCallWaitS', () => {
    const camera = SENSOR_SPEC_SETS.field.camera.outputs;
    const radar = SENSOR_SPEC_SETS.field.radar.outputs;
    assert.equal(ticksUntilCall(camera, { presence: true, count: 5, queueExtent: null }), 1);
    assert.equal(ticksUntilCall(radar, { presence: true, count: 5, queueExtent: null }), 30);
    assert.equal(ticksUntilCall(camera, { presence: true, count: 1, queueExtent: null }), 101); // 0.1 s summed 100 times falls a hair short of 10 s
});

test('the per-run spec hash tracks behaviour, not citations: a re-sourced number keeps it, a changed number or errors switch moves it', () => {
    const loop = SENSOR_SPEC_SETS.field.inductive_loop;
    const hash = sensorSpecHash(loop, false);
    assert.match(hash, /^[0-9a-f]{16}$/);
    assert.equal(sensorSpecHash({ ...loop, latency: { ...loop.latency, source: 'another citation' } }, false), hash);
    assert.notEqual(sensorSpecHash({ ...loop, latency: { ...loop.latency, ms: 90 } }, false), hash);
    assert.notEqual(sensorSpecHash(loop, true), hash);
    const hashes = SENSORS.flatMap((mode) => ['field', 'legacy'].map((set) => sensorSpecHash(SENSOR_SPEC_SETS[set][mode], false)));
    assert.equal(new Set(hashes).size, hashes.length);
});
