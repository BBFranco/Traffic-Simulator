/**
 * The rolling blackout (power state 'rolling_blackout'): the layout's zones, the engine darkening them stage by stage,
 * the resync hold per restore, junction-charged zone wait, and every power source resolved into one dark set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { ROLLING_SCHEDULE } from '../../resources/js/sim/batchSchedule.js';
import { loadCorridor } from '../../batch/trajectoryHash.mjs';
import { everyCar } from '../../batch/trajectoryHash.mjs';

const DT = 0.1;
const config = loadCorridor('hatfield-realistic');
const VERTICAL = ['Jan Shoba', 'Hilda', 'Festival', 'Grosvenor', 'Dyer Road', 'Herold Street'];

function engineFor(controllerMode, power = {}) {
    const layout = buildLayout(config);
    const engine = new SimulationEngine(layout);
    const arterialModes = Object.fromEntries(layout.arterials.map((a) => [a.id, controllerMode]));
    engine.reset({ seed: 7, arterialModes, demand: {}, sensorMode: 'inductive_loop', batteryBackedSensors: true, power: { offMinutes: 2, periodMinutes: 8, ...power }, routingMode: null });
    return { layout, engine };
}

function run(engine, seconds) {
    for (let i = 0; i < Math.round(seconds / DT); i += 1) engine.tick(DT);
}

/** The junctions that have lights to lose - roundabouts, stop streets and all-way stops never change. */
const signalled = (engine) => [...engine.nodesInfo.values()].filter((info) => !['roundabout', 'minorStop', 'none'].includes(info.controllerType) && info.node.control !== 'allWayStop');
const nodesInZones = (engine, zones) => new Set([...engine.zoneOfNode].filter(([, zone]) => zones.includes(zone)).map(([nodeId]) => nodeId));

/** Each signalled junction is an all-way stop exactly when it is in `darkNodes`, and the snapshot agrees. */
function assertDarkExactly(engine, expected, label) {
    assert.deepEqual([...engine.darkNodes].sort(), [...expected].sort(), `${label}: darkNodes`);
    const signals = engine.snapshot().signals;
    for (const info of signalled(engine)) {
        const dark = expected.has(info.node.id);
        assert.equal(info.controllerType === 'allWayStop', dark, `${label}: ${info.node.id} is ${info.controllerType}`);
        assert.equal(signals.get(info.node.id).dark, dark, `${label}: ${info.node.id} snapshot dark`);
    }
}

test('every intersection resolves to exactly one zone; vertical connectors have none', () => {
    const layout = buildLayout(config);
    const { engine } = { engine: new SimulationEngine(layout) };
    const allNodes = layout.arterials.flatMap((a) => a.intersections.map((n) => n.id));
    assert.equal(new Set(allNodes).size, allNodes.length, 'a junction sits on one arterial');
    for (const arterial of layout.arterials) {
        assert.ok([1, 2, 3].includes(arterial.zone), `${arterial.id} has a zone`);
        for (const node of arterial.intersections) assert.equal(engine.zoneOfNode.get(node.id), arterial.zone, node.id);
    }
    assert.equal(engine.zoneOfNode.size, allNodes.length);
    for (const connector of layout.connectors.filter((c) => VERTICAL.includes(c.name))) assert.equal(connector.zone, null, `${connector.id} is vertical`);
    assert.deepEqual(engine.zones, [1, 2, 3]);
});

test('stages darken exactly their zones, swap in one tick, and queues carry across', () => {
    const { engine } = engineFor('fixed');
    run(engine, 120);
    assertDarkExactly(engine, new Set(), 'before');
    assert.equal(engine.powerState, 'normal');

    engine.setZoneDark(ROLLING_SCHEDULE[0].zones);
    assert.equal(engine.powerState, 'rolling_blackout');
    assertDarkExactly(engine, nodesInZones(engine, [1, 3]), 'stage 1');
    // Zone 2's lit signals kept their controllers - only the arterials that changed are rebuilt.
    const zone2Controllers = new Map(signalled(engine).filter((i) => engine.zoneOfNode.get(i.node.id) === 2).map((i) => [i.node.id, i.controller]));
    run(engine, 60);
    for (const [nodeId, controller] of zone2Controllers) assert.equal(engine.nodesInfo.get(nodeId).controller, controller, `${nodeId} untouched`);

    const before = new Set(everyCar(engine).map((car) => car.id));
    engine.setZoneDark(ROLLING_SCHEDULE[1].zones);
    assertDarkExactly(engine, nodesInZones(engine, [2]), 'stage 2');
    const after = new Set(everyCar(engine).map((car) => car.id));
    assert.deepEqual(after, before, 'no car removed or added by the swap');

    run(engine, 60);
    engine.setZoneDark([]);
    assert.equal(engine.powerState, 'normal');
    assertDarkExactly(engine, new Set(), 'after');
    assert.equal(engine.carAccounting().balanced, true);
});

test('the resync hold fires once per restore, on the restored junctions only', () => {
    const { engine } = engineFor('coordinated_adaptive');
    run(engine, 60);
    engine.setZoneDark([1, 3]);
    run(engine, 30);
    assert.equal(engine.coordinationStats.recoveryHolds, 0);
    engine.setZoneDark([2]);
    assert.equal(engine.coordinationStats.recoveryHolds, 1);
    assert.deepEqual(new Set(engine.recoveryHoldUntil.keys()), nodesInZones(engine, [1, 3]));
    // A held junction rebuilt unmarried; zone 2 is dark, so it has no coordinated controller at all.
    for (const nodeId of engine.recoveryHoldUntil.keys()) {
        const info = engine.nodesInfo.get(nodeId);
        if (info.controllerType === 'coordinatedAdaptive') assert.equal(info.controller.married, false, nodeId);
    }
    run(engine, 30);
    engine.setZoneDark([]);
    assert.equal(engine.coordinationStats.recoveryHolds, 2);
    assert.equal(engine.coordinationStats.restores.length, 2);
    // Holds run out on their own clock (recoveryHoldS after each restore).
    run(engine, engine.coordination.recoveryHoldS + 1);
    assert.equal(engine.recoveryHoldUntil.size, 0);
});

test('unticking mid-stage-1 restores every junction in the next tick, with one hold per restored coordinated node', () => {
    const { engine } = engineFor('coordinated_adaptive');
    run(engine, 30);
    const nowS = engine.simTimeS;
    engine.setZoneSchedule([{ zones: [1, 3], fromS: nowS, toS: nowS + 900 }, { zones: [2], fromS: nowS + 900, toS: nowS + 1800 }]);
    run(engine, 10);
    assertDarkExactly(engine, nodesInZones(engine, [1, 3]), 'stage 1');
    engine.setZoneSchedule(null);
    run(engine, DT);
    assertDarkExactly(engine, new Set(), 'unticked');
    assert.equal(engine.coordinationStats.restores.length, 1);
    assert.deepEqual(new Set(engine.recoveryHoldUntil.keys()), nodesInZones(engine, [1, 3]));
});

test('zone wait is charged to the junction a car queues for, including on Jan Shoba', () => {
    const { layout, engine } = engineFor('fixed');
    const janShoba = layout.connectors.find((c) => c.name === 'Jan Shoba' && engine.connectorDirs.get(c.id).fwd.gates.some((g) => engine.zoneOfNode.get(g.node.id) === 2));
    const dir = engine.connectorDirs.get(janShoba.id).fwd;
    const gate = dir.gates.find((g) => engine.zoneOfNode.get(g.node.id) === 2);
    const car = { road: dir.road, distanceM: gate.stopLineDistanceM - 5, totalWaitS: 0, waitSeenS: 0 };
    assert.equal(dir.road.zone, null, 'Jan Shoba has no zone of its own');
    assert.equal(engine._waitZoneOf(car), 2, 'queued for a zone 2 junction');
    // In the box (past the stop line, short of the far side) it is still that junction's.
    car.distanceM = gate.centreDistanceM;
    assert.equal(engine._waitZoneOf(car), 2, 'in the box');

    car.totalWaitS = 12;
    engine._addWait(car, dir.road.statsKey, dir.road.roadId, engine._waitZoneOf(car));
    assert.deepEqual([...car.waitByZone], [[2, 12]]);

    // Past a horizontal road's last junction: the road's own zone.
    const stanza = engine.carriagewaysByArterial.get('stanza')[0];
    const tail = { road: stanza.road, distanceM: stanza.lengthM + 1e6 };
    assert.equal(engine._waitZoneOf(tail), 3);
});

test('every order of manual cut, scheduled outage and rolling blackout leaves exactly what the active source implies', () => {
    const { engine } = engineFor('fixed');
    run(engine, 10);
    const all = new Set(engine.nodesInfo.keys());
    const zone13 = nodesInZones(engine, [1, 3]);
    const sources = {
        manualOn: () => engine.setManualLoadShedding(true),
        manualOff: () => engine.setManualLoadShedding(false),
        // 8 min period, 2 min dark from each period's start: simTimeS is ~10 s in, so the schedule is dark now.
        scheduleOn: () => engine.setPowerSchedule({ scheduledOutages: true, offMinutes: 2, periodMinutes: 8 }),
        scheduleOff: () => engine.setPowerSchedule({ scheduledOutages: false }),
        rollingOn: () => engine.setZoneSchedule([{ zones: [1, 3], fromS: 0, toS: 1e6 }]),
        rollingOff: () => engine.setZoneSchedule(null),
    };
    const expected = (on) => (on.manual || on.schedule ? all : on.rolling ? zone13 : new Set());
    const sequences = [
        ['manualOn', 'rollingOn', 'manualOff', 'rollingOff'],
        ['rollingOn', 'manualOn', 'rollingOff', 'manualOff'],
        ['scheduleOn', 'rollingOn', 'scheduleOff', 'rollingOff'],
        ['rollingOn', 'scheduleOn', 'manualOn', 'scheduleOff', 'manualOff', 'rollingOff'],
        ['rollingOn', 'rollingOff', 'manualOn', 'manualOff', 'rollingOn', 'rollingOff'],
    ];
    for (const sequence of sequences) {
        const on = { manual: false, schedule: false, rolling: false };
        for (const step of sequence) {
            sources[step]();
            on[step.replace(/(On|Off)$/, '')] = step.endsWith('On');
            assertDarkExactly(engine, expected(on), sequence.join(' > ') + ` @ ${step}`);
        }
    }
});
