/**
 * All-way-stop box probe (long-outage pilot, 2026-10-24): how often does the 20 s occupancy backstop drop a car that is
 * still in the box, so the next approach is let in round it - and where? Total blackout from the start of the measured
 * window at peak demand, destination routing.
 *
 *   node scripts/preview/awsBoxProbe.mjs [controller=fixed] [seed=20260101] [darkMinutes=90]
 */
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { loadCorridor } from '../../batch/trajectoryHash.mjs';

const controllerMode = process.argv[2] ?? 'fixed';
const seed = Number(process.argv[3] ?? 20260101);
const darkMinutes = Number(process.argv[4] ?? 90);
const DT = 0.1;
const WARMUP_S = 3180;

const layout = buildLayout(loadCorridor('hatfield-realistic'));
const engine = new SimulationEngine(layout);
const arterialModes = Object.fromEntries(layout.arterials.map((a) => [a.id, controllerMode]));
const demand = Object.fromEntries([...layout.arterials, ...layout.connectors].map((r) => [r.id, r.demand.spawnRatePerLanePerMin]));
engine.reset({ seed, arterialModes, demand, sensorMode: 'inductive_loop', batteryBackedSensors: true, power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: 'destination' });

// Count backstop drops of occupants that were still in the box, per junction.
const drops = new Map();
const original = engine._allWayStopBoxOccupied.bind(engine);
engine._allWayStopBoxOccupied = (info, turningById) => {
    const before = new Map(info.allWayStopOccupants);
    const result = original(info, turningById);
    for (const [id, o] of before) {
        if (info.allWayStopOccupants.has(id) || engine.simTimeS - o.releasedAtS <= 20) continue;
        const gateRoad = o.gate.carriageway?.road ?? o.gate.dir?.road;
        const crossedWidthM = o.gate.phase === 0 ? info.node.crossRoadWidthM : info.node.arterialRoadWidthM;
        // Only a car that had driven into the box (nose over the stop line) - one still pulling up may be dropped.
        const stillIn = turningById.has(id) || (o.car.road === gateRoad && o.car.distanceM + o.car.lengthM / 2 > o.gate.stopLineDistanceM && o.car.distanceM - o.car.lengthM / 2 < o.gate.centreDistanceM + crossedWidthM / 2);
        if (!stillIn) continue;
        const d = drops.get(info.node.id) ?? { n: 0, first: null };
        d.n += 1;
        d.first ??= Math.round((engine.simTimeS - WARMUP_S) / 60);
        drops.set(info.node.id, d);
    }
    return result;
};

const totalTicks = Math.round((WARMUP_S + darkMinutes * 60) / DT);
for (let tick = 0; tick < totalTicks; tick += 1) {
    if (tick === Math.round(WARMUP_S / DT)) engine.setManualLoadShedding(true);
    engine.tick(DT);
}
const sorted = [...drops].sort((a, b) => b[1].n - a[1].n);
console.log(`${controllerMode} seed ${seed}, ${darkMinutes} min dark: backstop dropped a car still in the box ${sorted.reduce((s, [, d]) => s + d.n, 0)} times`);
for (const [node, d] of sorted.slice(0, 12)) console.log(`  ${node.padEnd(24)} ${String(d.n).padStart(5)}  first at ${d.first} min dark`);
const snap = engine.snapshot();
console.log(`cleared ${snap.total.clearedTotal}, mean wait ${(snap.total.waitSumTotal / snap.total.clearedTotal).toFixed(1)} s, on network ${engine.carAccounting().onRoadNetwork}, queued at entries ${engine.entryBacklogCount()}, delay ${((engine.accounting.waitAccruedS + engine.accounting.backlogWaitS) / 3600).toFixed(0)} veh-h`);
const lock = engine.lockupWatch.report();
console.log('lockup:', JSON.stringify({ isLockup: lock.isLockup, gridlock: lock.gridlock?.locked?.nodeId ?? lock.gridlock?.firstCycle?.nodeIds, boxStuck: lock.boxStuck }));
