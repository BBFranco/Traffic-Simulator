// The lockup watch's verdicts on a hand-built network: a waits-on cycle and a stuck queue are lockups, a car stood
// behind a queue that still moves is starved (saturation) - Franco's call, 2026-10-09.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LockupWatch, LOCKUP_STILL_S } from '../../resources/js/sim/lockupWatch.js';
import { buildPolylinePath } from '../../resources/js/sim/car.js';

/** A car going round junction n1 - a turn path is all the watch needs to place it. */
function ringCar(id, speedMps = 0) {
    const point = { x: id, y: 0 };
    return { id, speedMps, distanceM: 0, turnPath: { ...buildPolylinePath([point, point]), ringNodeId: 'n1' }, waitsOn: null };
}

function fakeEngine(turningCars) {
    return {
        simTimeS: 0,
        turningCars,
        carriagewayState: new Map(),
        connectorState: new Map(),
        nodesInfo: new Map([['n1', { node: { id: 'n1', point: { x: 0, y: 0 } }, controllerType: 'signal' }]]),
        joinsFrom: new Map(),
    };
}

function watchFor(engine, seconds) {
    const watch = new LockupWatch(engine);
    for (let t = 0; t <= seconds; t += 1) {
        engine.simTimeS = t;
        watch.observe();
    }
    return watch.report();
}

test('two cars waiting on each other for a minute are a lockup, named by the cycle', () => {
    const a = ringCar(1);
    const b = ringCar(2);
    a.waitsOn = b;
    b.waitsOn = a;

    const report = watchFor(fakeEngine([a, b]), 61);
    assert.equal(report.isLockup, true);
    assert.deepEqual(report.firstCycle.carIds, [1, 2]);
    assert.deepEqual(report.firstCycle.nodeIds, ['n1']);
});

test('a car stood behind a queue that is stuck as long is a lockup', () => {
    const head = ringCar(1);
    const behind = ringCar(2);
    behind.waitsOn = head;

    const report = watchFor(fakeEngine([head, behind]), LOCKUP_STILL_S);
    assert.equal(report.isLockup, true);
    assert.equal(report.locked.seconds, LOCKUP_STILL_S);
    assert.equal(report.starved, null);
});

test('a car stood behind a queue that still moves is starved, not a lockup', () => {
    const moving = ringCar(1, 1.5);
    const starved = ringCar(2);
    starved.waitsOn = moving;

    const report = watchFor(fakeEngine([moving, starved]), LOCKUP_STILL_S);
    assert.equal(report.isLockup, false);
    assert.equal(report.locked, null);
    assert.equal(report.starved.carId, 2);
});

test('a shorter standstill is neither', () => {
    const head = ringCar(1);
    const behind = ringCar(2);
    behind.waitsOn = head;

    const report = watchFor(fakeEngine([head, behind]), LOCKUP_STILL_S - 1);
    assert.equal(report.isLockup, false);
    assert.equal(report.locked, null);
    assert.equal(report.starved, null);
});
