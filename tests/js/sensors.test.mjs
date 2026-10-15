/** Sensor models (sensors.js) - the loop and the magnetometer must see moving and queued traffic differently. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAGNETOMETER_ADVANCE_M, detectAtAdvancePuck, detectPresenceAtStopLine, queueReachesAdvancePuck } from '../../resources/js/sim/sensors.js';

const STOP_LINE_M = 200;
const car = (upstreamM, stoppedNow = false) => ({ distanceM: STOP_LINE_M - upstreamM, stoppedNow });

test('a car approaching 30 m out: the magnetometer advance puck sees it, the stop-line loop does not', () => {
    const approaching = [car(MAGNETOMETER_ADVANCE_M)];
    assert.equal(detectPresenceAtStopLine(approaching, STOP_LINE_M), false);
    assert.equal(detectAtAdvancePuck(approaching, STOP_LINE_M), true);
});

test('only a queue standing back over the advance puck is an immediate magnetometer call', () => {
    const shortQueue = [car(2, true), car(9, true)];
    const longQueue = [car(2, true), car(9, true), car(16, true), car(23, true), car(30, true)];
    const movingOverPuck = [car(30, false)];
    assert.equal(queueReachesAdvancePuck(shortQueue, STOP_LINE_M), false);
    assert.equal(queueReachesAdvancePuck(longQueue, STOP_LINE_M), true);
    assert.equal(queueReachesAdvancePuck(movingOverPuck, STOP_LINE_M), false);
});
