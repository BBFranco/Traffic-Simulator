/**
 * buildStamp.mjs - which code a batch ran: the git commit and whether the working tree had
 * uncommitted changes. Read by batch/runBatch.mjs at the start of a CLI batch, and by
 * vite.config.js when it builds the /results bundle (exposed there as `__BUILD_STAMP__`).
 */
import { execSync } from 'node:child_process';

function git(args, cwd) {
    try {
        return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
}

/** `{ commit, dirty, source, at }` - commit null outside a git checkout. */
export function buildStamp(cwd, source) {
    const commit = git('rev-parse --short HEAD', cwd);
    const status = git('status --porcelain', cwd);
    return { commit, dirty: commit ? status !== '' : null, source, at: new Date().toISOString() };
}
