/**
 * Fixed-time plans (controllers/phasePlan.js's fixedTimeGreens()) against hand-worked Webster, and the SARTSM Vol 3
 * minimums (dissertation plan step 8): a 7 s main-phase green (§6.13.3) and a 30 s minimum cycle (§6.13.2).
 * Two stages, no turn arrows: L = 2 x 4 s = 8 s, s = 1250 veh/h/lane, C0 = (1.5L + 5) / (1 - Y) = 17 / (1 - Y).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_CYCLE_S, MIN_GREEN_S, buildStages, fixedTimeGreens } from '../../resources/js/sim/controllers/phasePlan.js';

const S = 1250;
const demand = (perLanePerMin) => ({ spawnRatePerLanePerMin: perLanePerMin, saturationFlowPerLanePerHour: S });
const plan = (arterialPerMin, crossPerMin) => fixedTimeGreens(buildStages([null, null]), demand(arterialPerMin), demand(crossPerMin), [null, null]);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.01, `${label}: ${actual} vs ${expected}`);

test('SARTSM minimums: 7 s main-phase green, 30 s cycle', () => {
    assert.equal(MIN_GREEN_S, 7);
    assert.equal(MIN_CYCLE_S, 30);
});

test('Webster unconstrained: y = 0.384 + 0.192, C0 = 17 / 0.424 = 40.09 s, greens split 2:1 of 32.09 s', () => {
    const { greens, cycleLengthS } = plan(8, 4);
    near(cycleLengthS, 17 / 0.424, 'cycle');
    near(greens[0], (0.384 / 0.576) * (17 / 0.424 - 8), 'arterial green');
    near(greens[1], (0.192 / 0.576) * (17 / 0.424 - 8), 'cross green');
});

test('minimum green binds, cycle above the floor: the cross green lifts to 7 s and the cycle grows by the lift', () => {
    // y = 0.48 + 0.024: C0 = 17 / 0.496 = 34.27 s; arterial 0.48 / 0.504 x 26.27 = 25.02 s, cross 1.25 s -> 7 s.
    const { greens, cycleLengthS } = plan(10, 0.5);
    const arterial = (0.48 / 0.504) * (17 / 0.496 - 8);
    near(greens[0], arterial, 'arterial green');
    near(greens[1], 7, 'cross green');
    near(cycleLengthS, arterial + 7 + 8, 'cycle');
});

test('cycle floor binds: a 24.8 s Webster cycle is stretched to 30 s, the cross green held at 7 s', () => {
    // y = 0.144 + 0.048: C0 = 17 / 0.808 = 21.04 s -> greens 9.78 / 3.26, lifted to 9.78 / 7, cycle 24.78 s < 30.
    // At C = 30 the 22 s of green splits 16.5 / 5.5; the cross lifts to 7 s and the arterial gives it up: 15 / 7.
    const { greens, cycleLengthS } = plan(3, 1);
    assert.equal(cycleLengthS, 30);
    near(greens[0], 15, 'arterial green');
    near(greens[1], 7, 'cross green');
    near(greens[0] + greens[1] + 8, 30, 'cycle adds up');
});

test('oversaturated (Y >= 1): the 120 s fallback, above both floors', () => {
    const { greens, cycleLengthS } = plan(15, 10);
    assert.equal(cycleLengthS, 120);
    assert.ok(greens.every((g) => g >= MIN_GREEN_S));
});
