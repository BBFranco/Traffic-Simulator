/**
 * The entry backlog (engine.js's _admitArrival(), Franco 2026-10-23): an arrival that finds its map-edge lane full
 * queues outside and drives in later, in arrival order - late, not lost. A lane that never fills is untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const DT = 0.1;
const admit = SimulationEngine.prototype._admitArrival;

/** A lane whose arrivals come every `gapS`, on a fake engine clock; `step(blocked)` advances one tick. */
function lane(gapS) {
    const engine = { simTimeS: 0, accounting: { arrivalsQueued: 0, backlogWaitS: 0 } };
    const state = { timerS: 0, nextArrivalS: gapS };
    let draws = 0;
    const step = (blocked) => {
        engine.simTimeS += DT;
        state.timerS += DT;
        const admitted = admit.call(engine, state, blocked, DT, () => {
            draws += 1;
            return gapS;
        });
        if (admitted && !admitted.fromBacklog) {
            // The caller's own reset after building the car, as _spawnForCarriageway() does.
            state.timerS = 0;
            state.nextArrivalS = gapS;
            draws += 1;
        }
        return admitted;
    };
    return { engine, state, step, draws: () => draws };
}

test('an open lane admits each arrival straight in, nothing queued', () => {
    const { engine, step } = lane(2);
    const entered = [];
    for (let i = 0; i < 100; i += 1) if (step(false)) entered.push(engine.simTimeS);
    assert.equal(entered.length, 5);
    assert.equal(engine.accounting.arrivalsQueued, 0);
    assert.equal(engine.accounting.backlogWaitS, 0);
});

test('a blocked lane queues its arrivals and lets them in, oldest first, once there is room', () => {
    const { engine, state, step } = lane(2);
    for (let i = 0; i < 100; i += 1) assert.equal(step(true), null); // 10 s blocked: arrivals due at 2, 4, 6, 8, 10 s
    assert.equal(engine.accounting.arrivalsQueued, 5);
    assert.equal(state.backlog.length, 5);

    const first = step(false);
    assert.equal(first.fromBacklog, true);
    assert.ok(Math.abs(first.queuedS - 8.1) < 1e-9, `${first.queuedS}`); // arrived at 2.0 s, in at 10.1 s

    const queuedS = [first.queuedS];
    for (let i = 0; i < 4; i += 1) queuedS.push(step(false).queuedS);
    assert.equal(state.backlog.length, 0);
    // One in per tick: 8.1, 6.2, 4.3, 2.4, 0.5 s outside - and the tick-by-tick backlog total is exactly their sum.
    assert.deepEqual(queuedS.map((q) => Math.round(q * 10) / 10), [8.1, 6.2, 4.3, 2.4, 0.5]);
    assert.ok(Math.abs(engine.accounting.backlogWaitS - queuedS.reduce((a, b) => a + b, 0)) < 1e-9, `${engine.accounting.backlogWaitS}`);
});

test('while others still queue, a new arrival joins the back of the queue instead of jumping it', () => {
    const { engine, state, step } = lane(0.2);
    for (let i = 0; i < 10; i += 1) step(true);
    const queued = engine.accounting.arrivalsQueued;
    step(false);
    assert.ok(engine.accounting.arrivalsQueued >= queued);
    assert.ok(state.backlog.every((t, i, all) => i === 0 || all[i - 1] <= t), 'arrival order kept');
});
