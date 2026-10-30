// Probes a stuck car of a stored long-protocol batch run inside headless Chromium (see browserProbeEntry.js).
// Bundle first:  npx rolldown scripts/preview/browserProbeEntry.js --file <out>/probe-bundle.js --format iife
// node scripts/preview/browserprobe.mjs <bundle.js> <raw_config.json> <power> <carId> <simS,simS,...> [--chain=25] [--ring=<nodeId>] [--stop=<nodeId>]
//   simS: engine seconds INCLUDING warm-up (the lockup report's atS).
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const [bundlePath, rawPath, powerState, carIdArg, atList] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const template = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.addScriptTag({ content: readFileSync(bundlePath, 'utf8') });
const lines = await page.evaluate(
    ([raw, cfg, power, carId, ats, options]) => window.probeLongRun(raw, cfg, power, carId, ats, options),
    [JSON.parse(readFileSync(rawPath, 'utf8')), template, powerState, Number(carIdArg), atList.split(',').map(Number), { chain: Number(opt('chain', 25)), ring: opt('ring', null), stop: opt('stop', null) }]
);
console.log(lines.join('\n'));
await browser.close();
