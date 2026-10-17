/**
 * buildStamp.mjs - which code a batch ran: the git commit and whether the working tree had
 * uncommitted changes. Read by batch/runBatch.mjs at the start of a CLI batch, and by
 * vite.config.js when it builds the /results bundle (exposed there as `__BUILD_STAMP__`).
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function git(args, cwd) {
    try {
        return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
}

/**
 * Short sha1 over every .js file under resources/js/sim - the simulation itself. Two stamps with the same `sim` ran the
 * same engine, committed or not: what a resumed batch (runBatch.mjs --resume, the /results Resume button) checks.
 */
export function simFingerprint(cwd) {
    const hash = createHash('sha1');
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            // Line endings normalised, so a checkout's CRLF/LF setting never reads as a code change.
            else if (entry.name.endsWith('.js')) hash.update(entry.name).update(fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n'));
        }
    };
    walk(path.join(cwd, 'resources', 'js', 'sim'));
    return hash.digest('hex').slice(0, 12);
}

/**
 * `{ commit, dirty, source, at, sim }` - commit null outside a git checkout, and dirty null (unknown, never clean)
 * whenever git couldn't say. `runGit` is the tests' seam.
 */
export function buildStamp(cwd, source, runGit = git) {
    const commit = runGit('rev-parse --short HEAD', cwd);
    const status = commit ? runGit('status --porcelain', cwd) : null;
    return { commit, dirty: status === null ? null : status !== '', source, at: new Date().toISOString(), sim: simFingerprint(cwd) };
}
