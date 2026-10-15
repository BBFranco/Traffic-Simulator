/**
 * Captures the trajectory-hash and runHeadless-summary baselines. By default only the cases a
 * baseline file doesn't have yet (a new matrix entry) - every existing key is kept as it is, so
 * adding a mode never quietly re-baselines the others. --all recaptures everything; run that ONLY on
 * a build whose dynamics and report output are the reference:
 *
 *   node tests\js\fixtures\captureBaselines.mjs [--all]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashRun, loadCorridor } from '../../../batch/trajectoryHash.mjs';
import { runHeadless } from '../../../resources/js/sim/runHeadless.js';
import { HASH_CORRIDOR, HASH_MATRIX, HASH_TICKS, SUMMARY_MATRIX, caseKey, rowsHash, summaryArgs } from './matrix.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadCorridor(HASH_CORRIDOR);
const recaptureAll = process.argv.includes('--all');
const existing = (file) => (recaptureAll || !fs.existsSync(path.join(here, file)) ? {} : JSON.parse(fs.readFileSync(path.join(here, file), 'utf8')));

const previousHashes = existing('trajectoryHash.baseline.json');
const hashes = {};
for (const c of HASH_MATRIX) {
    const key = caseKey(c);
    if (key in previousHashes) {
        hashes[key] = previousHashes[key];
        continue;
    }
    hashes[key] = hashRun({ config, ticks: HASH_TICKS, ...c }).trajectory;
    console.log('hash', key, hashes[key]);
}
fs.writeFileSync(path.join(here, 'trajectoryHash.baseline.json'), `${JSON.stringify(hashes, null, 2)}\n`);

const previousSummaries = existing('summary.baseline.json');
const summaries = {};
for (const c of SUMMARY_MATRIX) {
    const key = caseKey(c);
    if (key in previousSummaries) {
        summaries[key] = previousSummaries[key];
        continue;
    }
    const { summary, ...rowGroups } = runHeadless(summaryArgs(c, config));
    summaries[key] = { summary, rowsHash: rowsHash(rowGroups) };
    console.log('summary', key);
}
fs.writeFileSync(path.join(here, 'summary.baseline.json'), `${JSON.stringify(summaries, null, 2)}\n`);
