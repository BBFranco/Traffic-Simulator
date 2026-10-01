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

self.addEventListener('message', ({ data: { id, task, options } }) => {
    try {
        self.postMessage({ id, result: task === 'probeSeries' ? probeSeries(options) : runHeadless(options) });
    } catch (error) {
        self.postMessage({ id, error: error.message });
    }
});
