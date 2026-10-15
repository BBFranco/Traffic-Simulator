/**
 * Coordinated adaptive (controllers/coordinatedAdaptive.js, coordinationBus.js, selfTuning.js): the controller on a fake
 * clock, then the two Hatfield junctions where both opposing approaches get an arrow at once, in the full engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoordinatedAdaptiveController } from '../../resources/js/sim/controllers/coordinatedAdaptive.js';
import { CoordinationBus, travelTimeS } from '../../resources/js/sim/controllers/coordinationBus.js';
import { SelfTuner, chooseMarried } from '../../resources/js/sim/controllers/selfTuning.js';
import { buildStages } from '../../resources/js/sim/controllers/phasePlan.js';
import { planCoordination } from '../../resources/js/sim/controllers/greenWave.js';
import { COORDINATED_DEFAULTS } from '../../resources/js/sim/equations.js';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { loadCorridor } from '../../batch/trajectoryHash.mjs';

const DT = 0.1;

/** Two stages, arterial 30 s / cross 20 s: C = 58, yield points at 30 + 58k, cross force-off at 54 + 58k. */
const PLAIN = { offsetS: 0, cycleLengthS: 58, stages: buildStages([null, null]), stageGreens: [30, 20] };
/** An arterial lead arrow (8 s) in front of it: C = 70, arterial green 30-..., yield points at 30 + 70k, arrow window 58-66. */
const LEAD_TURN = { offsetS: -12, cycleLengthS: 70, stages: buildStages([{ weight: 1 }, null]), stageGreens: [8, 30, 20] };

const label = (c) => `${c.phase}${c.inTurn ? 't' : ''}:${c.phaseState}`;

/** Ticks `controller` from `fromS` to `toS`; `inputs(t)` gives the tick's detector inputs. Returns each change of state as [t, label]. */
function run(controller, fromS, toS, inputs) {
    const changes = [];
    let prev = label(controller);
    for (let i = Math.round(fromS / DT) + 1; i <= Math.round(toS / DT); i += 1) {
        const t = i * DT;
        const x = inputs(t);
        controller.tick(DT, t, x.detected ?? false, x.call ?? false, x.turnCalls ?? [false, false], x.platoon ?? null);
        const now = label(controller);
        if (now !== prev) changes.push([Math.round(t * 10) / 10, now]);
        prev = now;
    }
    return changes;
}

const greensOf = (changes) => changes.filter(([, s]) => s.endsWith(':green'));
const coord = (overrides) => ({ ...COORDINATED_DEFAULTS, ...overrides });

test('starts where the plan has it, and holds the arterial to its yield point despite a call', () => {
    const c = new CoordinatedAdaptiveController(PLAIN, 0);
    assert.equal(label(c), '0:green');
    const changes = run(c, 0, 34.5, () => ({ call: true, detected: false }));
    assert.deepEqual(changes[0][1], '0:yellow');
    assert.ok(Math.abs(changes[0][0] - 30) <= 0.15, `yielded at ${changes[0][0]}`);
});

test('force-off: a busy cross green ends at its planned end, and the arterial opens on time', () => {
    const c = new CoordinatedAdaptiveController(PLAIN, 0);
    const changes = run(c, 0, 60, (t) => ({ call: true, detected: t > 30 }));
    const crossEnd = changes.find(([, s]) => s === '1:yellow');
    assert.ok(Math.abs(crossEnd[0] - 54) <= 0.15, `cross forced off at ${crossEnd[0]}`);
    const arterial = changes.find(([t, s]) => s === '0:green' && t > 50);
    assert.ok(Math.abs(arterial[0] - 58) <= 0.25, `arterial reopened at ${arterial[0]}`);
    assert.equal(c.lastEnd.reason, 'forceOff');
});

test('early return: a cross green that gaps out hands its slack to the arterial, which then holds to the next yield point (re-service off)', () => {
    const c = new CoordinatedAdaptiveController(PLAIN, 0, { coord: coord({ reservice: false }) });
    const changes = run(c, 0, 92, () => ({ call: true, detected: false }));
    const crossEnd = changes.find(([, s]) => s === '1:yellow');
    assert.ok(Math.abs(crossEnd[0] - 42) <= 0.25, `cross gapped out at ${crossEnd[0]} (8 s minimum)`);
    const arterial = changes.find(([t, s]) => s === '0:green' && t > 40);
    assert.ok(Math.abs(arterial[0] - 46) <= 0.3, `arterial back at ${arterial[0]}`);
    const nextYield = changes.find(([t, s]) => s === '0:yellow' && t > 46);
    assert.ok(Math.abs(nextYield[0] - 88) <= 0.15, `held to the next yield point, yielded at ${nextYield?.[0]}`);
});

test('skip: no call on the cross street keeps the arterial resting through every yield point', () => {
    const c = new CoordinatedAdaptiveController(PLAIN, 0);
    assert.deepEqual(run(c, 0, 300, () => ({ call: false })), []);
});

test('permissive window: a late call is served only while the cross street can still get its minimum green', () => {
    const early = new CoordinatedAdaptiveController(PLAIN, 0);
    const served = run(early, 0, 45, (t) => ({ call: t >= 40 }));
    assert.ok(Math.abs(served[0][0] - 40) <= 0.15, `call at 40 served at ${served[0]?.[0]}`); // 54 - 40 = 14 >= 4 + 8

    const late = new CoordinatedAdaptiveController(PLAIN, 0);
    const deferred = run(late, 0, 89, (t) => ({ call: t >= 43 }));
    assert.equal(deferred[0][1], '0:yellow');
    assert.ok(Math.abs(deferred[0][0] - 88) <= 0.15, `call at 43 deferred to the next yield point, served at ${deferred[0][0]}`); // 54 - 43 = 11 < 12
});

test('lead arrow: runs only on a call, inside its planned window, and the arterial still opens on the offset', () => {
    const called = new CoordinatedAdaptiveController(LEAD_TURN, 0);
    assert.equal(label(called), '0:green');
    const withArrow = greensOf(run(called, 0, 72, (t) => ({ call: true, detected: t > 30, turnCalls: [true, false] })));
    assert.deepEqual(withArrow.map(([, s]) => s), ['1:green', '0t:green', '0:green']);
    assert.ok(Math.abs(withArrow[1][0] - 58) <= 0.25, `arrow opened at ${withArrow[1][0]}`);
    assert.ok(Math.abs(withArrow[2][0] - 70) <= 0.35, `arterial opened at ${withArrow[2][0]}`);

    const uncalled = new CoordinatedAdaptiveController(LEAD_TURN, 0);
    const without = greensOf(run(uncalled, 0, 72, (t) => ({ call: true, detected: t > 30 })));
    assert.deepEqual(without.map(([, s]) => s), ['1:green', '0:green']);
    assert.ok(Math.abs(without[1][0] - 58) <= 0.25, `arrow skipped - arterial back early at ${without[1][0]}`);
});

test('half-cycling: a junction on half the common cycle wraps on its own cycle - two yield points per common cycle', () => {
    const demand = (perMin) => ({ spawnRatePerLanePerMin: perMin, saturationFlowPerLanePerHour: 1250 });
    const nodeInfos = [{ node: { id: 'busy', sAlongM: 0 } }, { node: { id: 'quiet', sAlongM: 250 } }];
    const plan = planCoordination(nodeInfos, (n) => demand(n.id === 'busy' ? 9 : 2), (n) => demand(n.id === 'busy' ? 7 : 1), () => [null, null], 60 / 3.6);
    const common = plan.commonCycleS;
    const quiet = plan.nodes.get('quiet');
    assert.equal(quiet.cycleLengthS, common / 2, 'the quiet junction is half-cycled');
    const c = new CoordinatedAdaptiveController(quiet, 0);
    const yields = run(c, 0, 2 * common + 1, () => ({ call: true, detected: false })).filter(([, s]) => s === '0:yellow').map(([t]) => t);
    assert.ok(yields.length >= 3, `yields at ${yields}`);
    for (let i = 1; i < yields.length; i += 1) assert.ok(Math.abs(yields[i] - yields[i - 1] - common / 2) <= 0.15, `yields at ${yields}`);
});

test('a platoon due right after the yield point holds the arterial, capped at platoonExtendMaxS', () => {
    const due = (fromS, toS) => (toS >= 31 && fromS <= 33 ? 4 : 0); // 4 cars arriving 31-33 s
    const c = new CoordinatedAdaptiveController(PLAIN, 0);
    const held = run(c, 0, 40, () => ({ call: true, platoon: due }));
    const yieldAt = held.find(([, s]) => s === '0:yellow')[0];
    assert.ok(yieldAt > 32.9 && yieldAt < 33.5, `held for the platoon, yielded at ${yieldAt}`);

    const always = () => 10;
    const capped = new CoordinatedAdaptiveController(PLAIN, 0, { coord: coord({ platoonExtendMaxS: 5 }) });
    const cappedAt = run(capped, 0, 40, () => ({ call: true, platoon: always })).find(([, s]) => s === '0:yellow')[0];
    assert.ok(Math.abs(cappedAt - 35) <= 0.25, `extension capped at 5 s, yielded at ${cappedAt}`);
});

test('a platoon never holds the arterial past the point the cross street could still be served', () => {
    const c = new CoordinatedAdaptiveController(PLAIN, 0, { coord: coord({ platoonExtendMaxS: 60 }) });
    const changes = run(c, 0, 89, () => ({ call: true, platoon: () => 10 }));
    // The window closes at 54 - 12 = 42: an endless platoon holds it to there, then the waiting call goes - not a cycle later.
    assert.equal(changes[0][1], '0:yellow');
    assert.ok(changes[0][0] > 41.7 && changes[0][0] <= 42.05, `yielded at ${changes[0][0]}`);
});

test('early start: a thinned-out cross green ends for a platoon about to reach the arterial', () => {
    const due = (fromS, toS) => (fromS <= 45 && toS >= 44 ? 5 : 0);
    const c = new CoordinatedAdaptiveController(PLAIN, 0);
    // The cross street keeps actuating until 40, then thins out; the platoon is due at 44-45.
    const changes = run(c, 0, 50, (t) => ({ call: true, detected: t > 30 && t < 40, platoon: due }));
    const crossEnd = changes.find(([, s]) => s === '1:yellow');
    assert.ok(crossEnd[0] > 41.9 && crossEnd[0] < 42.5, `ended for the platoon at ${crossEnd[0]}, right after its 8 s minimum (gap-out alone would be 43)`);
});

test('travelTimeS: cruising is d/v; from rest adds v/2a', () => {
    assert.ok(Math.abs(travelTimeS(250, 50 / 3.6, 50 / 3.6, 1.4) - 250 / (50 / 3.6)) < 1e-9);
    const v = 60 / 3.6;
    assert.ok(Math.abs(travelTimeS(250, 0, v, 1.4) - (250 / v + v / 2.8)) < 1e-9);
});

test('bus: posts are counted in their window, dropped on arrival, and expire once stale', () => {
    const bus = new CoordinationBus();
    bus.post('n', 1, 10);
    bus.post('n', 2, 12);
    bus.post('m', 3, 11);
    assert.equal(bus.countWithin('n', 9, 12), 2);
    bus.arrived('n', 2);
    assert.equal(bus.viewFor('n')(9, 12), 1);
    bus.expire(12.5);
    assert.equal(bus.countWithin('n', 0, 100), 0);
    assert.equal(bus.countWithin('m', 0, 100), 1);
});

test('self-tuning: measured flow moves the cycle by at most the step, anchored on the boundary', () => {
    const node = { id: 'a', sAlongM: 0 };
    const demand = { spawnRatePerLanePerMin: 6, saturationFlowPerLanePerHour: 1250 };
    const args = { nodeInfos: [{ node }], arterialDemandFor: () => demand, crossDemandFor: () => ({ ...demand, spawnRatePerLanePerMin: 3 }), turnFor: () => [null, null], targetSpeedMps: 60 / 3.6 };
    const plan = { commonCycleS: 58, nodes: new Map([['a', { stages: buildStages([null, null]) }]]) };
    const tuner = new SelfTuner({ ...args, plan, nowS: 0, coord: coord({ retuneEveryCycles: 1, retuneSmoothing: 1, selective: false }) });
    // Heavy measured flow: 20 per lane-minute on the arterial, 15 on the cross street - Webster wants a far longer cycle.
    for (let i = 0; i < 20 * (58 / 60); i += 1) tuner.recordEntry('a', '0', 'art#0');
    for (let i = 0; i < 15 * (58 / 60); i += 1) tuner.recordEntry('a', '1', 'x#0');
    assert.equal(tuner.tick(57.9), null);
    const next = tuner.tick(58);
    assert.ok(next, 'retuned on the boundary');
    assert.equal(next.commonCycleS, 58 + COORDINATED_DEFAULTS.retuneMaxStepS);
    assert.equal(next.nodes.get('a').anchorS, 58);
    assert.ok(next.criticalCycleS > next.commonCycleS);
});

test('self-tuning: a controller takes a new plan up as its arterial green next opens, not mid-stage', () => {
    const c = new CoordinatedAdaptiveController(PLAIN, 0);
    run(c, 0, 35, () => ({ call: true, detected: true }));
    assert.equal(label(c), '1:green');
    c.setPlan({ ...PLAIN, cycleLengthS: 62, stageGreens: [32, 22], anchorS: 58 });
    run(c, 35, 50, () => ({ call: true, detected: true }));
    assert.equal(c.layout.C, 58, 'still on the old plan mid-cycle');
    run(c, 50, 60, () => ({ call: true, detected: true }));
    assert.equal(c.layout.C, 62, 'new plan from the arterial green on');
});

/** Runs the Hatfield corridor in coordinated adaptive and watches `nodeIds` for their turn stages. */
function watchTurnStages(nodeIds, ticks) {
    const engine = new SimulationEngine(buildLayout(loadCorridor('hatfield-realistic')));
    const layout = engine.layout;
    const arterialModes = Object.fromEntries(layout.arterials.map((a) => [a.id, 'coordinated_adaptive']));
    const demand = Object.fromEntries([...layout.arterials, ...layout.connectors].map((r) => [r.id, r.demand.spawnRatePerLanePerMin]));
    engine.reset({ seed: 7, arterialModes, demand, sensorMode: 'inductive_loop', batteryBackedSensors: true, power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: 'destination' });
    const seen = new Map(nodeIds.map((id) => [id, { stages: new Set(), problems: [] }]));
    for (let i = 0; i < ticks; i += 1) {
        engine.tick(DT);
        for (const id of nodeIds) {
            const info = engine.nodesInfo.get(id);
            const c = info.controller;
            if (!c.inTurn || c.phaseState !== 'green') continue;
            const watch = seen.get(id);
            if (watch.stages.has(c.phase)) continue;
            watch.stages.add(c.phase);
            const gates = info.turnStages[c.phase].gates;
            const turns = engine.snapshot().signals.get(id).turns;
            const arrows = gates.map((g) => turns[g.approach.id]);
            if (gates.length < 2) watch.problems.push(`${id} road ${c.phase}: only ${gates.length} arrow approach(es)`);
            if (!arrows.every((a) => a.green)) watch.problems.push(`${id} road ${c.phase}: not every arrow green`);
            if (arrows.some((a) => a.through)) watch.problems.push(`${id} road ${c.phase}: a through ball on beside two opposing arrows`);
            if (c.isArterialGreen() || c.isCrossGreen()) watch.problems.push(`${id} road ${c.phase}: a through green during the arrow stage`);
        }
    }
    return { engine, seen };
}

test('both opposing arrows run together - Duxbury & Jan Shoba, Lynnwood & Duxbury', { timeout: 300_000 }, () => {
    const { engine, seen } = watchTurnStages(['duxbury_janshoba', 'lynnwood_duxbury'], 12000);
    assert.equal(engine.nodesInfo.get('duxbury_janshoba').controllerType, 'coordinatedAdaptive');
    assert.deepEqual([...seen.get('duxbury_janshoba').stages], [0], 'Duxbury & Jan Shoba: its arterial arrow stage ran');
    assert.deepEqual([...seen.get('lynnwood_duxbury').stages].sort(), [0, 1], 'Lynnwood & Duxbury: both roads\' arrow stages ran');
    assert.deepEqual([...seen.values()].flatMap((w) => w.problems), []);
});

test('a planned cross split shorter than adaptive\'s minimum green is still served (Lunnon & Duxbury plans 7 s)', () => {
    const shortSplit = { offsetS: 0, cycleLengthS: 22, stages: buildStages([null, null]), stageGreens: [7, 7] };
    const c = new CoordinatedAdaptiveController(shortSplit, 0);
    const greens = greensOf(run(c, 0, 100, () => ({ call: true, detected: true })));
    assert.ok(greens.filter(([, s]) => s === '1:green').length >= 4, `cross greens: ${JSON.stringify(greens)}`);
});

test('re-service: a cross street calling again inside its window gets a second green once the arterial gaps out', () => {
    // Cross split 35 s: window open to 30 + 4 + 35 - 12 = 57. Cross gaps out at 42, arterial back at 46, quiet - minimum to 54.
    const longCross = { offsetS: 0, cycleLengthS: 73, stages: buildStages([null, null]), stageGreens: [30, 35] };
    const c = new CoordinatedAdaptiveController(longCross, 0);
    const changes = run(c, 0, 72, () => ({ call: true, detected: false }));
    const cross = greensOf(changes).filter(([, s]) => s === '1:green').map(([t]) => t);
    assert.equal(cross.length, 2, `cross greens at ${cross}`);
    assert.ok(Math.abs(cross[1] - 58) <= 0.6, `second cross green at ${cross[1]}`);
    const arterialEnd = changes.find(([t, s]) => s === '0:yellow' && t > 46);
    assert.ok(Math.abs(arterialEnd[0] - 54) <= 0.5, `arterial gave way at ${arterialEnd[0]}`);
    assert.equal(c.lastEnd.reason, 'gapOut');
});

test('re-service: never once the cross window has closed, and never while the arterial is still discharging', () => {
    const late = { ...PLAIN, stageGreens: [30, 20] };
    // Arterial busy (detected) after the early return: it doesn't gap out, so no second cross green.
    const busy = new CoordinatedAdaptiveController(late, 0);
    const busyCross = greensOf(run(busy, 0, 87, (t) => ({ call: true, detected: t > 46 }))).filter(([, s]) => s === '1:green');
    assert.equal(busyCross.length, 1, `cross greens ${JSON.stringify(busyCross)}`);
    // A long cross green leaves no room for a second one: gap-out at 50 -> arterial at 54 -> window (42) long closed.
    const full = new CoordinatedAdaptiveController(late, 0);
    const fullCross = greensOf(run(full, 0, 87, (t) => ({ call: true, detected: t > 30 && t < 47 }))).filter(([, s]) => s === '1:green');
    assert.equal(fullCross.length, 1, `cross greens ${JSON.stringify(fullCross)}`);
});

test('selective coordination: only links with strong arterial flow marry, and a married link divorces only below the hysteresis', () => {
    const nodeInfos = ['a', 'b', 'c', 'd'].map((id, i) => ({ node: { id, sAlongM: i * 250 } }));
    const v = 60 / 3.6;
    const flows = { a: 9, b: 8, c: 3, d: 2 };
    const first = chooseMarried(nodeInfos, (id) => flows[id], v, COORDINATED_DEFAULTS);
    assert.deepEqual([...first.nodes].sort(), ['a', 'b']);
    assert.deepEqual([...first.links], [0]);
    // a-b falls to 5.5: under the 6 to marry, over the 4.8 to divorce - stays married.
    const held = chooseMarried(nodeInfos, (id) => ({ ...flows, a: 5.5, b: 5.5 })[id], v, COORDINATED_DEFAULTS, first.links);
    assert.deepEqual([...held.links], [0]);
    const fresh = chooseMarried(nodeInfos, (id) => ({ ...flows, a: 5.5, b: 5.5 })[id], v, COORDINATED_DEFAULTS);
    assert.equal(fresh.links.size, 0);
    // Too far apart to carry a platoon: never married.
    const far = nodeInfos.map((info, i) => ({ node: { ...info.node, sAlongM: i * 900 } }));
    assert.equal(chooseMarried(far, (id) => flows[id], v, COORDINATED_DEFAULTS).nodes.size, 0);
    // Selective off: every link married.
    assert.equal(chooseMarried(nodeInfos, (id) => flows[id], v, coord({ selective: false })).nodes.size, 4);
});

test('divorced: plain adaptive rules - the cross street is served on a call after the minimum green, with no yield point', () => {
    const c = new CoordinatedAdaptiveController(PLAIN, 0, { married: false });
    const changes = run(c, 0, 20, (t) => ({ call: t >= 2, detected: false }));
    const firstEnd = changes.find(([, s]) => s === '0:yellow');
    assert.ok(firstEnd && Math.abs(firstEnd[0] - 8) <= 0.15, `arterial gave way at ${firstEnd?.[0]} (minimum green 8 s, not the 30 s yield point)`);
    // And it caps a busy green at maxGreen.
    const busy = new CoordinatedAdaptiveController(PLAIN, 0, { married: false });
    const capped = run(busy, 0, 50, () => ({ call: true, detected: true })).find(([, s]) => s === '0:yellow');
    assert.ok(Math.abs(capped[0] - 45) <= 0.15, `maxed out at ${capped[0]}`);
});

test('marrying back in waits for the arterial green to open; divorcing is immediate', () => {
    const c = new CoordinatedAdaptiveController(PLAIN, 0, { married: false });
    run(c, 0, 13, () => ({ call: true, detected: false })); // arterial gives way at 8, cross green from 12
    assert.equal(label(c), '1:green');
    c.setMarried(true);
    assert.equal(c.married, false, 'still isolated mid-cross-green');
    run(c, 10, 40, () => ({ call: true, detected: false }));
    assert.equal(c.married, true, 'married from the arterial green on');
    c.setMarried(false);
    assert.equal(c.married, false);
});

/** Ticks like run(), with the cross street's call age from `crossWaitS(t)`. */
function runWithWait(controller, fromS, toS, inputs, crossWaitS) {
    const changes = [];
    let prev = label(controller);
    for (let i = Math.round(fromS / DT) + 1; i <= Math.round(toS / DT); i += 1) {
        const t = i * DT;
        const x = inputs(t);
        controller.tick(DT, t, x.detected ?? false, x.call ?? false, x.turnCalls ?? [false, false], null, crossWaitS(t));
        const now = label(controller);
        if (now !== prev) changes.push([Math.round(t * 10) / 10, now]);
        prev = now;
    }
    return changes;
}

test('side-street cap (lever 1, off by default): a call that has waited sideMaxWaitS takes the green before the yield point, and is not forced off', () => {
    // After the early return at 46 the arterial would hold to its 88 yield point; the cross call passes 60 s at 51.
    const c = new CoordinatedAdaptiveController(PLAIN, 0, { coord: coord({ sideWaitCap: true }) });
    const changes = runWithWait(c, 0, 120, (t) => ({ call: true, detected: t > 58 && t < 100 }), (t) => (t > 46 && t < 58 ? t - 46 + 55 : 0));
    const capYield = changes.find(([t, s]) => s === '0:yellow' && t > 46);
    assert.ok(capYield[0] < 60, `arterial gave way at ${capYield[0]} - before its 88 yield point`);
    // Its queue keeps the detector busy to 100, past the plan's cross window, and it ends on gap-out rather than a force-off.
    const crossEnd = changes.find(([t, s]) => s === '1:yellow' && t > capYield[0]);
    assert.ok(crossEnd[0] > 99, `capped cross green ran on until its queue cleared, ended at ${crossEnd[0]}`);
});

test('side-street cap off (the default): the same waiting call holds to the yield point', () => {
    const c = new CoordinatedAdaptiveController(PLAIN, 0);
    const changes = runWithWait(c, 0, 90, () => ({ call: true, detected: false }), (t) => (t > 46 ? t - 46 + 55 : 0));
    const yields = changes.filter(([t, s]) => s === '0:yellow' && t > 46);
    assert.ok(Math.abs(yields[0][0] - 88) <= 0.15, `yielded at ${yields[0]?.[0]}`);
});

test('recovery hold: after power returns every coordinated junction runs as plain adaptive for recoveryHoldS, then marries back', { timeout: 300_000 }, () => {
    const engine = new SimulationEngine(buildLayout(loadCorridor('hatfield-realistic')));
    const layout = engine.layout;
    const arterialModes = Object.fromEntries(layout.arterials.map((a) => [a.id, 'coordinated_adaptive']));
    const demand = Object.fromEntries([...layout.arterials, ...layout.connectors].map((r) => [r.id, r.demand.spawnRatePerLanePerMin]));
    engine.reset({ seed: 3, arterialModes, demand, sensorMode: 'inductive_loop', batteryBackedSensors: true, power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: 'destination' });
    const coordinated = () => [...engine.nodesInfo.values()].filter((info) => info.controllerType === 'coordinatedAdaptive');
    const marriedCount = () => coordinated().filter((info) => info.controller.married || info.controller.pendingMarried).length;
    const marriedAtStart = marriedCount();
    assert.ok(marriedAtStart > 0, 'some junctions coordinate at the start');
    for (let i = 0; i < 100; i += 1) engine.tick(DT);
    engine.setManualLoadShedding(true);
    for (let i = 0; i < 100; i += 1) engine.tick(DT);
    engine.setManualLoadShedding(false);
    engine.tick(DT);
    assert.equal(marriedCount(), 0, 'all divorced as power returns');
    for (let i = 0; i < (COORDINATED_DEFAULTS.recoveryHoldS - 10) * 10; i += 1) engine.tick(DT);
    assert.equal(marriedCount(), 0, 'still divorced just before the hold ends');
    for (let i = 0; i < 200; i += 1) engine.tick(DT);
    assert.ok(marriedCount() > 0, 'married back in once the hold has ended');
});

test('route offsets: one direction gets travel time + start lag exactly; a two-way link the compromise of both', async () => {
    const { routeOffsets } = await import('../../resources/js/sim/controllers/coordinationRoutes.js');
    const { startFromRestLagS } = await import('../../resources/js/sim/controllers/greenWave.js');
    const v = 60 / 3.6;
    const t = 250 / v + startFromRestLagS(v);
    const oneWay = routeOffsets([{ nodeIds: ['a', 'b'], gapsM: [250], weight: 1 }], 60, v);
    assert.ok(Math.abs(oneWay.get('b') - t) <= 0.25, `offset ${oneWay.get('b')} vs ${t}`);
    // Both directions, equal weight: +t one way, -t the other - the best compromise is together (0) or half a cycle apart.
    const twoWay = routeOffsets([{ nodeIds: ['a', 'b'], gapsM: [250], weight: 1 }, { nodeIds: ['b', 'a'], gapsM: [250], weight: 1 }], 60, v);
    const off = twoWay.get('b');
    assert.ok(Math.min(off, 60 - off) <= 0.25 || Math.abs(off - 30) <= 0.25, `two-way offset ${off}`);
    // The heavier direction wins: 3:1 pulls it most of the way to its own wish.
    const weighted = routeOffsets([{ nodeIds: ['a', 'b'], gapsM: [250], weight: 3 }, { nodeIds: ['b', 'a'], gapsM: [250], weight: 1 }], 60, v);
    assert.ok(Math.abs(weighted.get("b") - (3 * t + (60 - t)) / 4) <= 0.3, `weighted offset ${weighted.get("b")} - the weighted mean of +t and -t round the cycle`);
});

test('route plan: coordinates phase 1 - the cross street\'s through green is the coordinated stage, stages back in real phases', async () => {
    const { planRoute } = await import('../../resources/js/sim/controllers/coordinationRoutes.js');
    const demand = (perMin) => ({ spawnRatePerLanePerMin: perMin, saturationFlowPerLanePerHour: 1250 });
    const nodeInfos = [{ node: { id: 'a' } }, { node: { id: 'b' } }];
    const route = { nodeInfos, coordinatedPhase: 1, chains: [{ nodeIds: ['a', 'b'], gapsM: [250], weight: 1 }], targetSpeedMps: 60 / 3.6 };
    const plan = planRoute(route, () => demand(3), () => demand(8), () => [null, { demand: demand(2), weight: 1 }]);
    const a = plan.nodes.get('a');
    assert.equal(a.coordinatedPhase, 1);
    assert.deepEqual(a.stages.map((s) => `${s.phase}${s.turn ? 't' : ''}`), ['1t', '1', '0']);
    const c = new CoordinatedAdaptiveController(a, 0);
    assert.equal(c.layout.coordinatedIndex, 1);
    // The busier cross street (8 vs 3) gets the bigger green.
    assert.ok(a.stageGreens[1] > a.stageGreens[2], `greens ${a.stageGreens}`);
});

test('coordinated phase 1: the cross street\'s green is held to its yield point and the arterial is the actuated one', () => {
    // Stages in cycle order [cross 30 s, arterial 20 s]: the cross street is coordinated, yield at 30.
    const plan = { offsetS: 0, cycleLengthS: 58, stages: [{ phase: 1, turn: false }, { phase: 0, turn: false }], stageGreens: [30, 20], coordinatedPhase: 1 };
    const c = new CoordinatedAdaptiveController(plan, 0);
    assert.equal(label(c), '1:green');
    const changes = run(c, 0, 60, (t) => ({ call: true, detected: t > 30 }));
    assert.ok(Math.abs(changes[0][0] - 30) <= 0.15 && changes[0][1] === '1:yellow', `cross yielded at ${changes[0]}`);
    const arterialEnd = changes.find(([, s]) => s === '0:yellow');
    assert.ok(Math.abs(arterialEnd[0] - 54) <= 0.15, `arterial forced off at ${arterialEnd[0]}`);
});
