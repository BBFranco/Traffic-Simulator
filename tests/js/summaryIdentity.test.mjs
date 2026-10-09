/**
 * The batch summary and per-tick rows stay byte-identical now that they compute through
 * metrics/definitions.js. Baselines: tests/js/fixtures/captureBaselines.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadCorridor } from '../../batch/trajectoryHash.mjs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { HASH_CORRIDOR, SUMMARY_MATRIX, caseKey, rowsHash, summaryArgs } from './fixtures/matrix.mjs';

const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/summary.baseline.json', import.meta.url), 'utf8'));
const config = loadCorridor(HASH_CORRIDOR);

for (const c of SUMMARY_MATRIX) {
    test(`summary and rows byte-identical: ${caseKey(c)}`, () => {
        const { summary, ...rowGroups } = runHeadless(summaryArgs(c, config));
        assert.equal(JSON.stringify(summary, null, 2), JSON.stringify(baseline[caseKey(c)].summary, null, 2));
        assert.equal(rowsHash(rowGroups), baseline[caseKey(c)].rowsHash);
    });
}
