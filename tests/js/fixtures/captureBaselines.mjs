/**
 * Captures the trajectory-hash and runHeadless-summary baselines. Run ONLY on a build whose
 * dynamics and report output are the reference:
 *
 *   node tests\js\fixtures\captureBaselines.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashRun, loadCorridor } from '../../../batch/trajectoryHash.mjs';
import { runHeadless } from '../../../resources/js/sim/runHeadless.js';
import { HASH_CORRIDOR, HASH_MATRIX, HASH_TICKS, SUMMARY_MATRIX, caseKey, rowsHash, summaryArgs } from './matrix.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadCorridor(HASH_CORRIDOR);

const hashes = {};
for (const c of HASH_MATRIX) {
    hashes[caseKey(c)] = hashRun({ config, ticks: HASH_TICKS, ...c }).trajectory;
    console.log('hash', caseKey(c), hashes[caseKey(c)]);
}
fs.writeFileSync(path.join(here, 'trajectoryHash.baseline.json'), `${JSON.stringify(hashes, null, 2)}\n`);

const summaries = {};
for (const c of SUMMARY_MATRIX) {
    const { summary, ...rowGroups } = runHeadless(summaryArgs(c, config));
    summaries[caseKey(c)] = { summary, rowsHash: rowsHash(rowGroups) };
    console.log('summary', caseKey(c));
}
fs.writeFileSync(path.join(here, 'summary.baseline.json'), `${JSON.stringify(summaries, null, 2)}\n`);
