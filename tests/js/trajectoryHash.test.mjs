/**
 * Dynamics-neutral guard: every car moves exactly as it did on the baseline build, with the live
 * statistics collector detached (batch) and attached and sampled at 1 Hz (browser).
 * Baselines: tests/js/fixtures/captureBaselines.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hashRun, loadCorridor } from '../../batch/trajectoryHash.mjs';
import { LiveMetrics } from '../../resources/js/sim/metrics/liveMetrics.js';
import { HASH_CORRIDOR, HASH_MATRIX, HASH_TICKS, caseKey } from './fixtures/matrix.mjs';

const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/trajectoryHash.baseline.json', import.meta.url), 'utf8'));
const config = loadCorridor(HASH_CORRIDOR);

for (const c of HASH_MATRIX) {
    test(`trajectory unchanged, collector off: ${caseKey(c)}`, () => {
        assert.equal(hashRun({ config, ticks: HASH_TICKS, ...c }).trajectory, baseline[caseKey(c)]);
    });
}

// Attached and sampled, with overlays on so every read path runs - on a cross-section of the matrix.
for (const c of HASH_MATRIX.filter((m) => m.seed === 1 || m.routingMode === 'destination')) {
    test(`trajectory unchanged, collector on: ${caseKey(c)}`, () => {
        let live = null;
        const { trajectory } = hashRun({
            config,
            ticks: HASH_TICKS,
            ...c,
            onStart: (engine) => {
                live = new LiveMetrics(engine);
                live.wantOverlays = true;
                engine.setLiveMetrics(live);
            },
            onTick: (_engine, tick) => {
                if ((tick + 1) % 10 === 0) live.sample();
            },
        });
        assert.equal(trajectory, baseline[caseKey(c)]);
    });
}
