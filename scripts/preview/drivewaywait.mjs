// Where driveway wait builds up: per-driveway wait of every pull-out in a batch-shaped load-shedding run, split pre-outage /
// dark / post-recovery (measured-window seconds), to see which blocks hold the wait and whether it is the dark phase.
// node scripts/preview/drivewaywait.mjs <config.json> <controller> <sensor> <seed,seed,...> [--warm=45000] [--no-outage]
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';

const [path, controllerMode, sensorMode, seeds] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const warmupTicks = Number(opt('warm', 45000));
const outage = !process.argv.includes('--no-outage');
const dt = 0.1;
const warmS = warmupTicks * dt;
const [darkFromS, darkToS] = [900, 1800];

let events = [];
let blocks = {};
function phaseOf(s) { return s < darkFromS ? 'pre' : s < darkToS ? 'dark' : 'post'; }
// Why a car that has already waited over a minute still can't pull out: mirrors the gap checks in _pullOutOfDriveway.
const reasonFor = (e, { driveway }) => {
    const carriageway = e.carriagewaysById.get(driveway.roadKey);
    const split = driveway.roadKey.lastIndexOf(':');
    const connectorId = carriageway ? null : driveway.roadKey.slice(0, split);
    const dirKey = carriageway ? null : driveway.roadKey.slice(split + 1);
    const state = carriageway ? e.carriagewayState.get(carriageway.id) : e.connectorState.get(connectorId)[dirKey];
    const lengthM = carriageway ? carriageway.lengthM : e.connectorsById.get(connectorId).routeLengthM;
    const laneIndex = e._drivewaySlot(driveway, state.laneLayout);
    const exitM = Math.min(driveway.atM + 8, lengthM - 1);
    const lane = state.lanes[laneIndex].cars;
    const stopped = lane.some((c) => Math.abs(c.distanceM - exitM) < 25 && c.speedMps < 1);
    const q = stopped ? '(queue)' : '(moving)';
    if (e._turnExitBlocked(state.lanes, laneIndex, exitM, 4.5)) return `exit-lane-blocked${q}`;
    if (lane.some((c) => c.distanceM < exitM && (exitM - c.distanceM) / Math.max(c.speedMps, 0.5) < 3)) return `approaching${q}`;
    if (driveway.crossesOncoming && e._drivewayCrossBlocked(driveway)) return 'oncoming';
    return 'other';
};
const pull = SimulationEngine.prototype._pullOutOfDriveway;
SimulationEngine.prototype._pullOutOfDriveway = function (waiting) {
    const ok = pull.call(this, waiting);
    if (!ok && this.simTimeS - waiting.queuedAtS > 60 && this.simTimeS - warmS >= 0) {
        const key = `${waiting.driveway.drivewayId.replace(/-[AB]\d+$/, '')} ${phaseOf(this.simTimeS - warmS)} ${reasonFor(this, waiting)}`;
        blocks[key] = (blocks[key] ?? 0) + 1;
    }
    const measuredS = this.simTimeS - warmS;
    if (ok && measuredS >= 0) events.push({ id: waiting.driveway.drivewayId, queuedS: waiting.queuedAtS - warmS, waitS: this.simTimeS - waiting.queuedAtS });
    return ok;
};

const corridorConfig = JSON.parse(readFileSync(path, 'utf8'));
for (const seed of seeds.split(',').map(Number)) {
    events = []; blocks = {};
    const { summary } = runHeadless({
        seed, controllerMode, sensorMode, corridorConfig, routingMode: 'destination', warmupTicks, durationTicks: 36000,
        powerOutageStartTick: outage ? 9000 : null, powerOutageEndTick: outage ? 18000 : null, sampleEverySeconds: 10,
    });
    const phases = { pre: [0, 0], dark: [0, 0], post: [0, 0] };
    const byDriveway = new Map();
    for (const e of events) {
        const p = phases[phaseOf(e.queuedS)];
        p[0] += 1; p[1] += e.waitS;
        const d = byDriveway.get(e.id) ?? [0, 0];
        d[0] += 1; d[1] += e.waitS;
        byDriveway.set(e.id, d);
    }
    const total = events.reduce((s, e) => s + e.waitS, 0);
    console.log(`seed ${seed}: pull-outs ${events.length} mean driveway wait ${(total / events.length).toFixed(2)} s (summary ${summary.routingStats?.meanDrivewayWaitS?.toFixed(2) ?? '?'}) still waiting ${summary.routingStats?.departuresWaiting ?? '?'}`);
    console.log('  by queued-at phase: ' + Object.entries(phases).map(([k, [n, w]]) => `${k} n=${n} mean ${(w / Math.max(n, 1)).toFixed(1)} s sum ${w.toFixed(0)}`).join(' | '));
    const top = [...byDriveway].sort((a, b) => b[1][1] - a[1][1]).slice(0, 10).map(([id, [n, w]]) => `${id} n=${n} sum ${w.toFixed(0)}s mean ${(w / n).toFixed(1)}s`);
    console.log('  top 10 driveways by total wait (share of all ' + total.toFixed(0) + ' s):\n    ' + top.join('\n    '));
    const grouped = {};
    for (const [k, n] of Object.entries(blocks)) { const [, ...r] = k.split(' '); grouped[r.join(' ')] = (grouped[r.join(' ')] ?? 0) + n; }
    console.log('  failed pull-out ticks (head waiting >60 s) by phase+reason: ' + JSON.stringify(grouped));
    console.log('  worst blocks: ' + JSON.stringify(Object.entries(blocks).sort((a, b) => b[1] - a[1]).slice(0, 8)));
}
