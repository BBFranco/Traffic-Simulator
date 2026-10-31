/**
 * The long-outage protocol's evening demand (demandProfile.js, dissertation plan step 7.2): Joubert et al. (2000)
 * Figure 5's hourly shares, placed at each hour's middle and interpolated, as a multiple of the 8.9 % peak.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENING_PROFILE, clockLabel, hourPlanMultiplier, profileMultiplier } from '../../resources/js/sim/demandProfile.js';
import { LONG_PROTOCOL } from '../../resources/js/sim/batchSchedule.js';

const at = (h, m = 0) => (h * 60 + m) * 60;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);

test('each hour holds its share at its middle: 18:30 is the peak, 1', () => {
    near(profileMultiplier(EVENING_PROFILE, at(18, 30)), 1);
    near(profileMultiplier(EVENING_PROFILE, at(17, 30)), 8.8 / 8.9);
    near(profileMultiplier(EVENING_PROFILE, at(20, 30)), 3.9 / 8.9);
});

test('linear between hour middles, held flat past the ends', () => {
    near(profileMultiplier(EVENING_PROFILE, at(19)), (8.9 + 6.2) / 2 / 8.9);
    near(profileMultiplier(EVENING_PROFILE, at(14)), 5.5 / 8.9);
    near(profileMultiplier(EVENING_PROFILE, at(23, 59)), 1.7 / 8.9);
});

test('the long protocol: 16:15-22:30, outage from 16:30, 4 h dark or 2 h + 2 h by zone, 2 h after the restore', () => {
    const { measuredTicks, powerOutageStartTick, powerOutageEndTick, rollingSchedule, startClockS } = LONG_PROTOCOL;
    const clock = (tick) => clockLabel(startClockS + tick * 0.1);
    assert.equal(clock(0), '16:15');
    assert.equal(clock(powerOutageStartTick), '16:30');
    assert.equal(clock(powerOutageEndTick), '20:30');
    assert.equal(clock(measuredTicks), '22:30');
    assert.deepEqual(rollingSchedule.map((w) => [w.zones, clock(w.fromTick), clock(w.toTick)]), [[[1, 3], '16:30', '18:30'], [[2], '18:30', '20:30']]);
});

test('time-of-day plans: each clock hour is timed for its own share, held flat past the ends', () => {
    near(hourPlanMultiplier(EVENING_PROFILE, at(16, 15)), 6.0 / 8.9);
    near(hourPlanMultiplier(EVENING_PROFILE, at(18, 59)), 1);
    near(hourPlanMultiplier(EVENING_PROFILE, at(20, 30)), 3.9 / 8.9);
    near(hourPlanMultiplier(EVENING_PROFILE, at(12)), 5.5 / 8.9);
    near(hourPlanMultiplier(EVENING_PROFILE, at(23, 30)), 1.7 / 8.9);
});
