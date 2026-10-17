/**
 * A roundabout, stop street or all-way stop by layout has no lights to lose: every power switch mid-run - a total
 * blackout and its restore, each rolling-blackout stage - leaves its controller and its record of the cars in its
 * ring or box exactly as they were (engine.js's _rebuildController()). The trajectory hashes can't show this: their
 * total blackout is dark from tick 0, before any car reaches a ring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCorridor, startEngine } from '../../batch/trajectoryHash.mjs';

const DT = 0.1;
const config = loadCorridor('hatfield-realistic');

function run(engine, seconds) {
    for (let i = 0; i < Math.round(seconds / DT); i += 1) engine.tick(DT);
}

/** Per native-control junction: its controller object and the car ids in its ring/box records. */
function nativeState(engine) {
    const ids = (map) => [...(map?.keys() ?? [])].map((key) => (typeof key === 'object' ? key.id : key)).sort();
    return new Map(
        [...engine.nodesInfo]
            .filter(([, info]) => ['roundabout', 'stop', 'allWayStop'].includes(info.node.control))
            .map(([nodeId, info]) => [nodeId, { controller: info.controller, occupants: ids(info.roundaboutOccupants), waiting: ids(info.roundaboutWaiting), box: ids(info.allWayStopOccupants) }])
    );
}

function assertSwitchKeepsState(engine, label, toggle) {
    const before = nativeState(engine);
    toggle();
    const after = nativeState(engine);
    for (const [nodeId, state] of before) {
        const kept = after.get(nodeId);
        assert.equal(kept.controller, state.controller, `${label}: ${nodeId} got a new controller`);
        assert.deepEqual({ ...kept, controller: null }, { ...state, controller: null }, `${label}: ${nodeId} lost its ring/box record`);
    }
    return [...before.values()].filter((state) => state.occupants.length + state.waiting.length + state.box.length > 0).length;
}

for (const controllerMode of ['fixed', 'adaptive', 'coordinated_adaptive']) {
    test(`native controls keep their cars through every mid-run power switch: ${controllerMode}`, () => {
        const { engine } = startEngine({ config, seed: 1, controllerMode, routingMode: 'destination' });
        run(engine, 600);
        let occupied = 0;
        occupied += assertSwitchKeepsState(engine, 'total blackout starts', () => engine.setManualLoadShedding(true));
        run(engine, 120);
        occupied += assertSwitchKeepsState(engine, 'total blackout ends', () => engine.setManualLoadShedding(false));
        run(engine, 120);
        occupied += assertSwitchKeepsState(engine, 'zones 1 + 3 dark', () => engine.setZoneDark([1, 3]));
        run(engine, 120);
        occupied += assertSwitchKeepsState(engine, 'zone 2 dark', () => engine.setZoneDark([2]));
        run(engine, 120);
        occupied += assertSwitchKeepsState(engine, 'all lit', () => engine.setZoneDark([]));
        // Not vacuous: the switches happened with cars in the rings and boxes.
        assert.ok(occupied >= 5, `only ${occupied} occupied junction-switches - the test would pass on the old rebuild`);
    });
}
