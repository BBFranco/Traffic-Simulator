/**
 * The live panel's run-to-date avg wait and throughput equal the batch summary's for the same
 * run: same seed, same warm-up reset, same measured window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCorridor, startEngine } from '../../batch/trajectoryHash.mjs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { LiveMetrics } from '../../resources/js/sim/metrics/liveMetrics.js';

const config = loadCorridor('hatfield-realistic');
const WARMUP_TICKS = 600;
const DURATION_TICKS = 3000;

for (const controllerMode of ['fixed', 'adaptive']) {
    test(`live avg wait and throughput equal the report: seed 4, ${controllerMode}`, () => {
        const { summary } = runHeadless({
            seed: 4,
            controllerMode,
            sensorMode: 'inductive_loop',
            warmupTicks: WARMUP_TICKS,
            corridorConfig: config,
            durationTicks: DURATION_TICKS,
        });

        const { engine } = startEngine({ config, seed: 4, controllerMode });
        const live = new LiveMetrics(engine);
        engine.setLiveMetrics(live);
        for (let tick = 0; tick < WARMUP_TICKS + DURATION_TICKS; tick += 1) {
            if (tick === WARMUP_TICKS) {
                engine.resetStats();
                live.reset();
            }
            engine.tick(0.1);
            if ((tick + 1) % 10 === 0) live.sample();
        }
        const s = live.latest;
        assert.ok(s.completed > 100, 'enough vehicles cleared to mean something');
        assert.equal(s.avgWaitRun, summary.avgWaitTime);
        assert.equal(s.throughputRunPerMin, summary.throughputPerMin);
        assert.equal(s.zeroStopPct, summary.pctClearedWithoutStop);
    });
}
