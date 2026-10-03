// Screenshot of the real 2D renderer over a corridor config: node scripts/preview/shot.mjs <config.json> <out.png> <x> <y> <scale> [w h]
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '../..');
const [configPath, out, cx, cy, scale, w = 900, h = 650] = process.argv.slice(2);
const config = readFileSync(configPath, 'utf8');
const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };
const page = `<!doctype html><body style="margin:0"><canvas id="c" style="width:${w}px;height:${h}px"></canvas>
<script type="module">
import { buildLayout } from '/resources/js/sim/corridor.js';
import { LayoutRenderer } from '/resources/js/sim/renderer.js';
const config = await (await fetch('/config.json')).json();
const layout = buildLayout(config);
const r = new LayoutRenderer(document.getElementById('c'), { pixelRatio: 1 });
r.setLayout(layout);
r.camera.centre = { x: ${cx}, y: ${cy} }; r.camera.scale = ${scale};
r.draw();
window.__done = true;
</script>`;
const server = createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end(page); }
    if (req.url === '/config.json') { res.setHeader('content-type', 'application/json'); return res.end(config); }
    try { const body = readFileSync(join(root, decodeURIComponent(req.url.split('?')[0]))); res.setHeader('content-type', types[extname(req.url)] ?? 'text/plain'); res.end(body); } catch { res.statusCode = 404; res.end(); }
});
await new Promise((r) => server.listen(0, r));
const require = createRequire(import.meta.url);
const { chromium } = require(join(root, 'node_modules/playwright'));
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
p.on('pageerror', (e) => console.error('PAGEERROR', e.message));
p.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()));
await p.goto(`http://localhost:${server.address().port}/`);
await p.waitForFunction('window.__done === true', null, { timeout: 20000 }).catch(() => console.error('render did not finish'));
await p.screenshot({ path: out });
await browser.close(); server.close();
