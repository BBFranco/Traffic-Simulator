/**
 * metrics/definitions.js and metrics/liveMetrics.js on hand-built vehicle states: stop counting,
 * queues and spillback, the stranded and blocked-box thresholds, arrivals on green, drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Car, stepCar } from '../../resources/js/sim/car.js';
import { BLOCKED_BOX_S, STRANDED_S, avgWait, driftState, zeroStopPct } from '../../resources/js/sim/metrics/definitions.js';
import { LiveMetrics, turnNodeId } from '../../resources/js/sim/metrics/liveMetrics.js';

const emptyBucket = () => ({ clearedTotal: 0, clearedWithoutStopTotal: 0, waitSumTotal: 0, recentClears: [] });

/**
 * The engine surface LiveMetrics reads: one 400 m one-lane arterial with stop lines at 100 m
 * (junction A) and 300 m (junction B), no connectors.
 */
function fakeEngine({ cars = [], turningCars = [], stillSinceS = new Map(), simTimeS = 1000 } = {}) {
    const road = { statsKey: 'art', lanes: 1 };
    const lane = { cars };
    const carriageway = { id: 'art:fwd', arterial: { id: 'art' }, road, lengthM: 400, gates: [] };
    const nodeA = { id: 'A', name: 'Art & A', control: null };
    const nodeB = { id: 'B', name: 'Art & B', control: null };
    const signal = { controllerType: 'fixed', controller: { isArterialGreen: () => true } };
    const infoA = { node: nodeA, arterialGates: [], crossGates: [], ...signal };
    const infoB = { node: nodeB, arterialGates: [], crossGates: [], ...signal };
    const gateA = { carriageway, node: nodeA, info: infoA, stopLineDistanceM: 100 };
    const gateB = { carriageway, node: nodeB, info: infoB, stopLineDistanceM: 300 };
    carriageway.gates = [gateA, gateB];
    infoA.arterialGates = [gateA];
    infoB.arterialGates = [gateB];
    const arterial = { id: 'art', shortName: 'Art', intersections: [nodeA, nodeB] };
    return {
        simTimeS,
        tickNo: 0,
        powerState: 'normal',
        routingActive: false,
        accounting: { arrivalsLost: 0 },
        layout: { arterials: [arterial], connectors: [] },
        carriageways: [carriageway],
        carriagewaysByArterial: new Map([['art', [carriageway]]]),
        carriagewayState: new Map([['art:fwd', { lanes: [lane] }]]),
        connectorState: new Map(),
        connectorDirs: new Map(),
        arterialState: new Map([['art', { stats: { ...emptyBucket(), clearedByNode: { A: 0, B: 0 } } }]]),
        sideStreetStats: emptyBucket(),
        totalStats: emptyBucket(),
        turningCars,
        nodesInfo: new Map([['A', infoA], ['B', infoB]]),
        feedersByGate: new Map(),
        lockupWatch: { stillSinceS },
        _gateLanes: () => [lane],
        _roadName: () => 'Art',
        carInfo: () => ({ roadName: 'Art' }),
        gates: { gateA, gateB },
    };
}

const stoppedAt = (id, distanceM) => ({ id, distanceM, speedMps: 0, stoppedNow: true, totalWaitS: 30, road: { statsKey: 'art' } });

test('a stop is a drop below the threshold after being above it, not every stopped tick', () => {
    const car = new Car({ road: { lanes: 1 }, lane: 0, distanceM: 0, speedMps: 10, desiredSpeedMps: 14 });
    const wall = (atM) => ({ distanceM: atM, speedMps: 0 });
    for (let i = 0; i < 200; i += 1) stepCar(car, wall(30), 0.1);
    assert.equal(car.stoppedNow, true);
    assert.equal(car.stopCount, 1, 'standing still for many ticks is one stop');
    for (let i = 0; i < 100; i += 1) stepCar(car, null, 0.1);
    assert.equal(car.stoppedNow, false);
    const secondWall = wall(car.distanceM + 40);
    for (let i = 0; i < 300; i += 1) stepCar(car, secondWall, 0.1);
    assert.equal(car.stoppedNow, true);
    assert.equal(car.stopCount, 2);
});

test('queue counts stopped vehicles between the stop line and the one before it; reaching back is spillback', () => {
    const engine = fakeEngine({ cars: [stoppedAt(1, 295), stoppedAt(2, 288), stoppedAt(3, 110), { ...stoppedAt(4, 250), stoppedNow: false, speedMps: 8 }] });
    const live = new LiveMetrics(engine);
    const s = live.sample();
    assert.equal(s.maxQueue.queue, 3);
    assert.equal(s.maxQueue.nodeId, 'B');
    assert.equal(s.spillbackNow, 1, 'a stopped car 10 m past A backs into A');
    assert.equal(s.spillbackEvents, 1);
    live.sample();
    assert.equal(live.latest.spillbackEvents, 1, 'a spillback still active is not a new event');
    engine.carriagewayState.get('art:fwd').lanes[0].cars.splice(2, 1);
    assert.equal(live.sample().spillbackNow, 0);
});

test('stranded: continuous standstill of STRANDED_S or more', () => {
    const now = 1000;
    const engine = fakeEngine({ stillSinceS: new Map([[1, now - STRANDED_S], [2, now - STRANDED_S + 1], [3, now - 5000]]), simTimeS: now });
    assert.equal(new LiveMetrics(engine).sample().stranded, 2);
});

test('blocked box: a turning car stopped in a junction longer than BLOCKED_BOX_S', () => {
    const turner = { id: 9, speedMps: 0, stoppedNow: true, totalWaitS: 0, road: { statsKey: 'side' }, turnPath: { key: 'art:fwd@B:c1:fwd:0' } };
    const engine = fakeEngine({ turningCars: [turner] });
    const live = new LiveMetrics(engine);
    assert.equal(live.sample().blockedNow, 0);
    engine.simTimeS += BLOCKED_BOX_S;
    assert.equal(live.sample().blockedNow, 0, 'exactly the dwell is not yet blocked');
    engine.simTimeS += 1;
    const s = live.sample();
    assert.equal(s.blockedNow, 1);
    assert.equal(s.blockedEvents, 1);
    turner.speedMps = 3;
    assert.equal(live.sample().blockedNow, 0);
});

test('turn paths name their junction', () => {
    const nodes = new Map([['B', {}], ['R', {}]]);
    assert.equal(turnNodeId({ key: 'art:fwd@B:c1:fwd:0' }, nodes), 'B');
    assert.equal(turnNodeId({ key: 'B:c1:fwd->art:fwd:0' }, nodes), 'B');
    assert.equal(turnNodeId({ key: 'R:ring:north', ringNodeId: 'R' }, nodes), 'R');
    assert.equal(turnNodeId({ key: 'driveway:12' }, nodes), null);
});

test('arrivals on green: crossed on green without stopping on that approach', () => {
    const engine = fakeEngine();
    const live = new LiveMetrics(engine);
    const { gateA, gateB } = engine.gates;
    const car = { stopCount: 0 };
    live.onStopLineCross(car, gateA); // no stop: on green
    car.stopCount = 1;
    live.onStopLineCross(car, gateB); // stopped before B
    gateA.info.controller.isArterialGreen = () => false;
    const other = { stopCount: 0 };
    live.onStopLineCross(other, gateA); // red
    gateA.info.controllerType = 'roundabout';
    live.onStopLineCross({ stopCount: 0 }, gateA); // not a signal: not an arrival
    assert.equal(live.arrivals, 3);
    assert.equal(live.arrivalsOnGreen, 1);
    assert.equal(live.sample().arrivalsOnGreenPct, (1 / 3) * 100);
});

test('stops per vehicle and the report figures come from the same counters', () => {
    const engine = fakeEngine();
    const live = new LiveMetrics(engine);
    live.onVehicleClear({ stopCount: 2 });
    live.onVehicleClear({ stopCount: 0 });
    Object.assign(engine.totalStats, { clearedTotal: 2, clearedWithoutStopTotal: 1, waitSumTotal: 40, recentClears: [{ tS: 999, waitS: 40 }, { tS: 999.5, waitS: 0 }] });
    const s = live.sample();
    assert.equal(s.stopsPerVeh, 1);
    assert.equal(s.zeroStopPct, zeroStopPct(1, 2));
    assert.equal(s.avgWaitRun, avgWait(40, 2));
    assert.equal(s.avgWaitRolling, 20);
    assert.equal(s.throughputPerMin, 2);
});

test('drift: settling until 5 min of windows, then settled when flat and drifting when climbing', () => {
    assert.equal(driftState(Array(200).fill(30)).state, 'settling');
    const flat = Array.from({ length: 600 }, (_, i) => 30 + Math.sin(i / 7));
    assert.equal(driftState(flat).state, 'settled');
    const climbing = Array.from({ length: 600 }, (_, i) => 20 + i * 0.1);
    assert.equal(driftState(climbing).state, 'drifting');
});

test('power cut: outage window and live throughput against the 10 min before it', () => {
    const engine = fakeEngine();
    const live = new LiveMetrics(engine);
    engine.totalStats.recentClears = Array(20).fill({ tS: 999, waitS: 0 });
    for (let i = 0; i < 10; i += 1) {
        engine.tickNo += 10;
        live.sample();
    }
    engine.powerState = 'load_shedding';
    engine.totalStats.recentClears = Array(10).fill({ tS: 999, waitS: 0 });
    engine.tickNo += 10;
    const s = live.sample();
    assert.equal(s.power.state, 'load_shedding');
    assert.equal(s.power.recoveryPct, 50);
    const [outage] = live.chartSeries().outages;
    assert.equal(Math.round(outage.fromS), 11);
    assert.equal(outage.toS, null);
    engine.powerState = 'normal';
    engine.tickNo += 10;
    live.sample();
    assert.equal(Math.round(live.chartSeries().outages[0].toS), 12);
});
