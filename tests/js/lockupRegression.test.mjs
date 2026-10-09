// Pinned run: the one that locked up at south_hilda in batch 8bf652df (adaptive, camera, load shedding, seed 20270104,
// destination routing, batch-shaped 60 + 60 min). Takes a couple of minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';

const corridorConfig = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));

test('camera seed 20270104 runs without a lockup', { timeout: 600_000 }, () => {
    const { summary } = runHeadless({
        seed: 20270104,
        controllerMode: 'adaptive',
        sensorMode: 'camera',
        routingMode: 'destination',
        corridorConfig,
        warmupTicks: 36000,
        durationTicks: 36000,
        powerOutageStartTick: 9000,
        powerOutageEndTick: 18000,
        sampleEverySeconds: 10,
    });

    const { lockup } = summary.diagnostics;
    assert.equal(lockup.isLockup, false, JSON.stringify(lockup));
    assert.ok(summary.maxWait < 1000, `max wait ${summary.maxWait}`);
    // 170.2/min after the 2026-10-09 fix; the locked run cleared 140.2.
    assert.ok(Math.abs(summary.throughputPerMin - 170) < 5, `throughput ${summary.throughputPerMin}`);
});
