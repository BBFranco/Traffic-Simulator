/**
 * sim/batchWorker.js - runs one headless run per message, off the main thread.
 *
 * The /results batch (results.js's runBatch()) used to call runHeadless()
 * directly, which blocked the page for the whole of every run - the progress
 * bar and the running badge's traffic-light loader only got a frame between
 * runs. runHeadless() does no DOM or file I/O, so it runs here unchanged.
 * results.js starts one of these per spare CPU core and hands out runs to
 * whichever is free.
 *
 * `task: 'probeSeries'` runs one warm-up probe run instead (sim/warmupProbe.js)
 * and posts back only its per-scope wait series, not the per-tick rows.
 */
import { runHeadless } from './runHeadless.js';
import { probeSeries } from './warmupProbe.js';

/**
 * Only what results.js's runBatch() reads: the per-arterial `rows` (the bulk of a run, ~16 rows per sim second) are
 * left behind, so they're neither copied to the page nor held there while the run waits its turn to be taken.
 */
function batchResult(options) {
    const { sideStreetRows, totalRows, arterialScopeRows, summary } = runHeadless(options);
    return { sideStreetRows, totalRows, arterialScopeRows, summary };
}

self.addEventListener('message', ({ data: { id, task, options } }) => {
    try {
        self.postMessage({ id, result: task === 'probeSeries' ? probeSeries(options) : batchResult(options) });
    } catch (error) {
        self.postMessage({ id, error: error.message });
    }
});
