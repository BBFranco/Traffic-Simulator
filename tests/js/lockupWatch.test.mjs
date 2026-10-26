// The lockup watch's verdicts on a hand-built network: a waits-on cycle and a stuck queue are lockups, a car stood
// behind a queue that still moves is starved (saturation) - Franco's call, 2026-10-09.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LockupWatch, LOCKUP_STILL_S, LOCK_CONFIRM_S, BOX_STUCK_S, AFTERMATH_REACH_M } from '../../resources/js/sim/lockupWatch.js';
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

    const report = watchFor(fakeEngine([head, behind]), LOCKUP_STILL_S + LOCK_CONFIRM_S);
    assert.equal(report.isLockup, true);
    assert.equal(report.locked.seconds, LOCKUP_STILL_S + LOCK_CONFIRM_S);
    assert.equal(report.starved, null);
});

test('a queue whose head is released the moment it reads stuck is not a lockup', () => {
    const head = ringCar(1);
    const behind = ringCar(2);
    behind.waitsOn = head;

    // The head has stood LOCKUP_STILL_S and pulls away: the chain read stuck for only a couple of seconds.
    const report = watchFor(fakeEngine([head, behind]), LOCKUP_STILL_S + LOCK_CONFIRM_S - 2);
    assert.equal(report.isLockup, false);
    assert.equal(report.locked, null);
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

// Dissertation plan step 7.6 (Franco, 2026-10-23): a lockup that starts while junctions are dark is gridlock under
// all-way stops - reported apart, not a fault; one that starts with every junction lit still is.
test('a cycle that forms while a junction is dark is gridlock, not a lockup', () => {
    const a = ringCar(1);
    const b = ringCar(2);
    a.waitsOn = b;
    b.waitsOn = a;
    const engine = { ...fakeEngine([a, b]), darkNodes: new Set(['n1']) };

    const report = watchFor(engine, 61);

    assert.equal(report.isLockup, false);
    assert.equal(report.firstCycle, null);
    assert.deepEqual(report.gridlock.firstCycle.nodeIds, ['n1']);
});

test('a cycle that formed while lit stays a lockup when the junction goes dark later', () => {
    const a = ringCar(1);
    const b = ringCar(2);
    a.waitsOn = b;
    b.waitsOn = a;
    const engine = { ...fakeEngine([a, b]), darkNodes: new Set() };
    const watch = new LockupWatch(engine);
    for (let t = 0; t <= 61; t += 1) {
        engine.simTimeS = t;
        if (t === 30) engine.darkNodes = new Set(['n1']);
        watch.observe();
    }

    const report = watch.report();
    assert.equal(report.isLockup, true);
    assert.equal(report.gridlock, null);
});

test('a car that joins a dark-period jam after the power is back is that gridlock, not a new lockup', () => {
    const head = ringCar(1);
    const late = ringCar(2, 1.5);
    late.waitsOn = head;
    const engine = { ...fakeEngine([head, late]), darkNodes: new Set(['n1']) };
    const watch = new LockupWatch(engine);
    const end = 200 + LOCKUP_STILL_S + LOCK_CONFIRM_S;
    for (let t = 0; t <= end; t += 1) {
        engine.simTimeS = t;
        if (t === 100) engine.darkNodes = new Set(); // power back; the head has stood since t = 0
        if (t === 200) late.speedMps = 0; // joins the jam while every junction is lit
        watch.observe();
    }

    const report = watch.report();
    assert.equal(report.isLockup, false, JSON.stringify(report));
    assert.equal(report.gridlock.locked.carId, 1);
});

// Box-stuck (Franco, 2026-10-23): a car standing BOX_STUCK_S inside a junction box is recorded, long before a lockup.
test('a car standing in a junction box for BOX_STUCK_S is box-stuck, not yet a lockup', () => {
    const report = watchFor(fakeEngine([ringCar(1)]), BOX_STUCK_S);
    assert.equal(report.isLockup, false);
    assert.equal(report.boxStuck.cars, 1);
    assert.deepEqual(report.boxStuck.byNode, { n1: 1 });
    assert.equal(report.boxStuck.longest.seconds, BOX_STUCK_S);
});

test('a shorter stand in the box is not box-stuck', () => {
    assert.equal(watchFor(fakeEngine([ringCar(1)]), BOX_STUCK_S - 1).boxStuck, null);
});

test('a lane car is in the box past its stop line and short of the far kerb, not at the line', () => {
    const watch = new LockupWatch(fakeEngine([]));
    const gate = { node: { id: 'x', crossRoadWidthM: 10, arterialRoadWidthM: 14 }, phase: 0, stopLineDistanceM: 95, centreDistanceM: 100 };
    const at = (distanceM) => watch._boxNodeId({ car: { distanceM, lengthM: 4.5 }, gates: [gate] });
    assert.equal(at(93), null); // waiting at the line
    assert.equal(at(100), 'x'); // mid-box
    assert.equal(at(107.2), 'x'); // rear (104.95) still short of the far kerb (105)
    assert.equal(at(108), null); // clear
});

test('after a restore, a lit lockup next to a junction that jammed while dark is aftermath, not a fault', () => {
    const jammed = ringCar(1);
    const later = ringCar(2, 1.5);
    const engine = { ...fakeEngine([jammed, later]), darkNodes: new Set(['n1']) };
    const watch = new LockupWatch(engine);
    const end = 400 + LOCKUP_STILL_S + LOCK_CONFIRM_S;
    for (let t = 0; t <= end; t += 1) {
        engine.simTimeS = t;
        if (t === 350) {
            engine.darkNodes = new Set(); // power back after the dark jam at n1 has stood 300+ s
            engine.turningCars = [later]; // the jam clears; a new queue forms there, lit
        }
        if (t === 400) later.speedMps = 0;
        watch.observe();
    }

    const report = watch.report();
    assert.equal(report.isLockup, false, JSON.stringify(report));
    assert.equal(report.gridlock.aftermath.locked.carId, 2);
});

test('after a restore, a lit queue that runs back from a junction near a dark jam is aftermath however far its tail stands', () => {
    const farX = 2 * AFTERMATH_REACH_M;
    const jammed = ringCar(1);
    const head = ringCar(5, 1.5); // at the dark jam's junction
    const tail = { ...ringCar(farX, 1.5), id: 6 }; // queued back to a junction beyond AFTERMATH_REACH_M of it
    tail.waitsOn = head;
    const engine = { ...fakeEngine([jammed]), darkNodes: new Set(['n1']) };
    engine.nodesInfo.set('n2', { node: { id: 'n2', point: { x: farX, y: 0 } }, controllerType: 'signal' });
    const watch = new LockupWatch(engine);
    const end = 400 + LOCKUP_STILL_S + LOCK_CONFIRM_S;
    for (let t = 0; t <= end; t += 1) {
        engine.simTimeS = t;
        if (t === 350) {
            engine.darkNodes = new Set(); // power back after the dark jam at n1 has stood 300+ s
            engine.turningCars = [head, tail]; // the jam clears; a new queue forms from n1 back past n2, lit
        }
        if (t === 400) head.speedMps = tail.speedMps = 0;
        watch.observe();
    }

    const report = watch.report();
    assert.equal(report.isLockup, false, JSON.stringify(report));
    assert.ok([5, 6].includes(report.gridlock.aftermath.locked.carId));
});

// Prospect & Hilda (2026-10-25): two entries let in for one gap at the exit; the one that got there second was refused
// at its yield line, let in but out of roundaboutExitHeld, and with no link read as a lockup on its own.
function roundaboutEngine(entrant, blocker) {
    const exitLanes = [{ cars: [blocker] }];
    const gate = { approach: { id: 'a' }, carriageway: { id: 'in' }, stopLineDistanceM: 100 };
    return {
        ...fakeEngine([]),
        carriagewayState: new Map([['in', { lanes: [{ cars: [entrant] }] }], ['out', { lanes: exitLanes }]]),
        carriagewaysById: new Map([['in', { gates: [] }], ['out', { gates: [] }]]),
        nodesInfo: new Map([
            ['r', { node: { id: 'r', point: { x: 0, y: 0 }, roundabout: { mouthM: 5 } }, controllerType: 'roundabout', arterialGates: [gate], crossGates: [], roundaboutExitHeld: new Set() }],
        ]),
        _roundaboutArrivals: () => [], // let in: no arrival any more
        _roundaboutTarget: () => ({ lanes: exitLanes, laneIndex: 0, centreM: 200 }),
        _roundaboutExitFull: () => true,
    };
}

test('a car let into a roundabout but refused at its yield line for want of room waits on the car blocking its exit', () => {
    const entrant = { id: 1, distanceM: 99, lengthM: 4.5, speedMps: 0, releasedNodeIds: new Set(['r']), turnPlan: { nodeId: 'r' } };
    const blocker = { id: 2, distanceM: 208, lengthM: 4.5, speedMps: 0 };
    const cars = new LockupWatch(roundaboutEngine(entrant, blocker))._liveCars();
    assert.equal(cars.find((entry) => entry.car === entrant).waitsOn, blocker);
});

test('a car not yet let in, and not held for its exit, is not linked to the exit', () => {
    const entrant = { id: 1, distanceM: 99, lengthM: 4.5, speedMps: 0, releasedNodeIds: new Set(), turnPlan: { nodeId: 'r' } };
    const blocker = { id: 2, distanceM: 208, lengthM: 4.5, speedMps: 0 };
    const cars = new LockupWatch(roundaboutEngine(entrant, blocker))._liveCars();
    assert.equal(cars.find((entry) => entry.car === entrant).waitsOn, null);
});
