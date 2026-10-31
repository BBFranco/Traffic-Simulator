// Replays stored long-protocol batch runs inside headless Chromium (its V8, not Node's) - one page per run, side by side.
// Bundle the entry first:  npx rolldown scripts/preview/browserReplayEntry.js --file <out>/replay-bundle.js --format iife
// node scripts/preview/browserreplay.mjs <bundle.js> <power> <raw_config.json> [<raw_config.json> ...]
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [bundlePath, powerState, ...rawPaths] = process.argv.slice(2);
const bundle = readFileSync(bundlePath, 'utf8');
const template = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ headless: true });
console.log(`chromium ${browser.version()}`);
await Promise.all(
    rawPaths.map(async (rawPath) => {
        const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
        const page = await browser.newPage();
        await page.addScriptTag({ content: bundle });
        const result = await page.evaluate(([r, cfg, power]) => window.replayLongRun(r, cfg, power), [raw, structuredClone(template), powerState]);
        console.log(JSON.stringify({ seed: raw.seed, mode: raw.controllerMode, sensor: raw.sensorMode, ...result }));
    })
);
await browser.close();
