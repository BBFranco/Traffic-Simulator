// Pinned runs that locked up in a batch, batch-shaped (warm-up + 60 min measured, load shedding). A few minutes each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';

const corridorConfig = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));

// Batch 8bf652df (destination routing): two cars round south_hilda waited on each other for good. Since the Jan Shoba
// merge fix this seed's run no longer reaches that deadlock even with the old ring logic, so it guards the run as a
// whole; roundaboutLeaders.test.mjs covers the ring rule itself.
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

// Batch 6e6c9e99 (random turning, 38 min warm-up): Jan Shoba's southbound merge starved its merging lane after the outage.
test('random-turning seed 20270101 runs without a lockup at the Jan Shoba merge', { timeout: 600_000 }, () => {
    const { summary } = runHeadless({
        seed: 20270101,
        controllerMode: 'adaptive',
        sensorMode: 'inductive_loop',
        routingMode: 'random',
        corridorConfig,
        warmupTicks: 22800,
        durationTicks: 36000,
        powerOutageStartTick: 9000,
        powerOutageEndTick: 18000,
        sampleEverySeconds: 10,
    });

    const { lockup } = summary.diagnostics;
    assert.equal(lockup.isLockup, false, JSON.stringify(lockup));
    // 167.1/min after the 2026-10-09 merge fix; the starved run cleared 163.0.
    assert.ok(summary.throughputPerMin > 165, `throughput ${summary.throughputPerMin}`);
});
