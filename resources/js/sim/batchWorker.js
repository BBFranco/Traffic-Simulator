/**
 * sim/batchWorker.js - runs one headless run per message, off the main thread.
 *
 * The /results batch (results.js's runBatch()) used to call runHeadless()
 * directly, which blocked the page for the whole of every run - the progress
 * bar and the running badge's traffic-light loader only got a frame between
 * runs. runHeadless() does no DOM or file I/O, so it runs here unchanged.
 */
import { runHeadless } from './runHeadless.js';

self.addEventListener('message', ({ data: { id, options } }) => {
    try {
        self.postMessage({ id, result: runHeadless(options) });
    } catch (error) {
        self.postMessage({ id, error: error.message });
    }
});
