/**
 * Fixed-time plans (controllers/phasePlan.js's fixedTimeGreens()) against hand-worked Webster, and the SARTSM Vol 3
 * minimums (dissertation plan step 8): a 7 s main-phase green (§6.13.3) and a 30 s minimum cycle (§6.13.2).
 * Two stages, no turn arrows: L = 2 x 4 s = 8 s, s = 1250 veh/h/lane, C0 = (1.5L + 5) / (1 - Y) = 17 / (1 - Y).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CYCLE_S, MIN_CYCLE_S, MIN_GREEN_S, buildStages, fixedTimeGreens, sartsmMaxGreens } from '../../resources/js/sim/controllers/phasePlan.js';

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

test('practice floor (plan step 14): a 60 s floor stretches a 40 s Webster cycle to 60 s; 0 and 30 change nothing', () => {
    const stages = buildStages([null, null]);
    const run = (floorS) => fixedTimeGreens(stages, demand(8), demand(4), [null, null], floorS);
    assert.deepEqual(run(0), run(30));
    const { greens, cycleLengthS } = run(60);
    assert.equal(cycleLengthS, 60);
    near(greens[0] + greens[1] + 8, 60, 'cycle adds up');
    near(greens[0], 2 * greens[1], 'Webster 2:1 split kept');
});

test('oversaturated (Y >= 1): the 120 s fallback, above both floors', () => {
    const { greens, cycleLengthS } = plan(15, 10);
    assert.equal(cycleLengthS, 120);
    assert.ok(greens.every((g) => g >= MIN_GREEN_S));
});

/*
 * The adaptive maximum-green sensitivity (sartsmMaxGreens(), plan Phase 4 item 6). Stages in buildStages() order:
 * [turn 0, through 0, turn 1, through 1] with both turn arrows (weight 1), so L = 16 s and the usual maxima
 * 25 + 45 + 25 + 45 = 140 s make a 156 s cycle - over 120 s, so the cap applies: the maxima share 104 s.
 */
const bothTurns = (turn0PerMin, turn1PerMin) => [
    { demand: demand(turn0PerMin), weight: 1 },
    { demand: demand(turn1PerMin), weight: 1 },
];
const sartsm = (arterialPerMin, crossPerMin, turn) => sartsmMaxGreens(buildStages(turn), demand(arterialPerMin), demand(crossPerMin), turn);

test('SARTSM max green: a two-stage junction keeps 45 s on both roads (2 x 45 + 8 = 98 s fits in 120 s)', () => {
    assert.equal(MAX_CYCLE_S, 120);
    assert.deepEqual(sartsm(8, 4, [null, null]), [45, 45]);
    assert.deepEqual(sartsm(15, 10, [null, null]), [45, 45]);
});

test('SARTSM max green: Webster greens scaled to a 120 s cycle, the arterial held at its 45 s maximum', () => {
    // y = 0.096 (turn 0) + 0.288 + 0.048 (turn 1) + 0.144 = 0.576: C0 = (1.5 x 16 + 5) / 0.424 = 68.40 s, 52.40 s of green
    // split 8.73 / 26.20 / 4.37 -> 6 (turn minimum) / 13.10. Scaled to 104 s the arterial would get 50.4 s > 45 s: held at
    // 45 s, the other three share the remaining 59 s in their Webster proportions.
    const turn = bothTurns(2, 1);
    const effective = 29 / 0.424 - 16;
    const webster = [(0.096 / 0.576) * effective, (0.288 / 0.576) * effective, 6, (0.144 / 0.576) * effective];
    const free = webster[0] + webster[2] + webster[3];
    const maxima = sartsm(6, 3, turn);
    near(maxima[1], 45, 'arterial');
    near(maxima[0], (webster[0] / free) * 59, 'arterial turn');
    near(maxima[2], (webster[2] / free) * 59, 'cross turn');
    near(maxima[3], (webster[3] / free) * 59, 'cross');
    near(maxima.reduce((sum, g) => sum + g, 0) + 16, 120, 'cycle');
});

test('SARTSM max green: minimum and usual maximum both hold - 8 s cross floor, 45 s / 25 s caps', () => {
    // y = 0.048 + 0.672 + 0.048 + 0.024: Webster ~7.5 / 104.7 / 7.5 / 3.7 -> 7. Scaled to 104 s: the arterial caps at
    // 45 s and the cross floors at adaptive's 8 s minimum; the turns' 25.5 s each then cap at 25 s. 103 s <= 104 s.
    assert.deepEqual(sartsm(14, 0.5, bothTurns(1, 1)), [25, 45, 25, 8]);
});

test('SARTSM max green: oversaturated - the 120 s fallback greens are the maxima (12 s turns, 40 s through)', () => {
    const maxima = sartsm(15, 10, bothTurns(5, 5));
    [12, 40, 12, 40].forEach((g, i) => near(maxima[i], g, `stage ${i}`));
});
