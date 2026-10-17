/**
 * Which code a batch ran: a failed git call or a failed fresh-stamp fetch must read as unknown, never as clean.
 * batch/buildStamp.mjs serves the CLI runner (and its --resume, which reuses the checkpoint's stamp) and
 * vite.config.js; resources/js/buildStampClient.js serves /results batches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildStamp } from '../../batch/buildStamp.mjs';
import { currentBuildStamp } from '../../resources/js/buildStampClient.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const gitAnswering = (answers) => (args) => answers[args] ?? null;

test('a clean tree stamps clean', () => {
    const stamp = buildStamp(ROOT, 'cli', gitAnswering({ 'rev-parse --short HEAD': 'abc1234', 'status --porcelain': '' }));
    assert.equal(stamp.commit, 'abc1234');
    assert.equal(stamp.dirty, false);
});

test('a dirty tree stamps dirty', () => {
    const stamp = buildStamp(ROOT, 'cli', gitAnswering({ 'rev-parse --short HEAD': 'abc1234', 'status --porcelain': ' M engine.js' }));
    assert.equal(stamp.dirty, true);
});

test('git status failing leaves the tree state unknown, not clean', () => {
    const stamp = buildStamp(ROOT, 'cli', gitAnswering({ 'rev-parse --short HEAD': 'abc1234' }));
    assert.equal(stamp.commit, 'abc1234');
    assert.equal(stamp.dirty, null);
});

test('no git at all leaves commit and tree state unknown', () => {
    const stamp = buildStamp(ROOT, 'cli', () => null);
    assert.equal(stamp.commit, null);
    assert.equal(stamp.dirty, null);
    assert.match(stamp.sim, /^[0-9a-f]{12}$/);
});

const baked = { commit: 'abc1234', dirty: true, source: 'vite-dev', sim: 'aaaaaaaaaaaa' };
const fresh = { commit: 'abc1234', dirty: false, source: 'vite-dev', sim: 'bbbbbbbbbbbb', fresh: true };
const respond = (body, ok = true) => async () => ({ ok, json: async () => body });

test('a dev-server batch takes the fresh stamp', async () => {
    assert.deepEqual(await currentBuildStamp(baked, respond(fresh)), fresh);
});

test('a failed fetch, an error status or a stamp without `fresh` falls back to the baked, unchecked stamp', async () => {
    assert.equal(await currentBuildStamp(baked, async () => { throw new TypeError('network'); }), baked);
    assert.equal(await currentBuildStamp(baked, respond(fresh, false)), baked);
    assert.equal(await currentBuildStamp(baked, respond({ ...fresh, fresh: undefined })), baked);
    assert.equal(await currentBuildStamp(baked, async () => ({ ok: true, json: async () => { throw new SyntaxError('html'); } })), baked);
});

test('a built bundle keeps its own stamp and never asks', async () => {
    const built = { ...baked, source: 'vite-build', dirty: false };
    assert.equal(await currentBuildStamp(built, () => assert.fail('fetched')), built);
});
