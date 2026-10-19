/**
 * The batch summary and per-tick rows stay byte-identical now that they compute through
 * metrics/definitions.js. Baselines: tests/js/fixtures/captureBaselines.mjs.
 *
 * Additive keys (a newer summary field the baseline predates - the rolling blackout's zoneStats, darkWindows, the
 * coordination record's byStage) are left out: the comparison runs on the baseline's own keys, at every depth, and on
 * the four original row groups. Every value the baseline has must still match exactly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadCorridor } from '../../batch/trajectoryHash.mjs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { HASH_CORRIDOR, SUMMARY_MATRIX, caseKey, rowsHash, summaryArgs } from './fixtures/matrix.mjs';

const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/summary.baseline.json', import.meta.url), 'utf8'));
const config = loadCorridor(HASH_CORRIDOR);

/** `actual` cut down to the keys `shape` has, recursively - so a key added since the baseline doesn't fail it. */
function onBaselineKeys(actual, shape) {
    if (Array.isArray(shape) || shape === null || typeof shape !== 'object' || actual === null || typeof actual !== 'object') return actual;
    return Object.fromEntries(Object.keys(shape).map((key) => [key, onBaselineKeys(actual[key], shape[key])]));
}

for (const c of SUMMARY_MATRIX) {
    test(`summary and rows byte-identical: ${caseKey(c)}`, () => {
        const { summary, rows, sideStreetRows, totalRows, arterialScopeRows } = runHeadless(summaryArgs(c, config));
        const expected = baseline[caseKey(c)].summary;
        assert.equal(JSON.stringify(onBaselineKeys(summary, expected), null, 2), JSON.stringify(expected, null, 2));
        assert.equal(rowsHash({ rows, sideStreetRows, totalRows, arterialScopeRows }), baseline[caseKey(c)].rowsHash);
    });
}
