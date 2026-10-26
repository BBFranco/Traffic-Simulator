// Replays one long-protocol (375 min evening) batch run and, at chosen sim times, prints a car's waits-on chain
// (lockupWatch.js's graph) with the dark-jam junctions the aftermath rule measures against.
// node scripts/preview/longlockprobe.mjs <controller> <power> <seed> <giveUpMin> <warmupTicks> <carId> <simS,simS,...> [--chain=40]
//   simS: engine seconds INCLUDING warm-up (lockup report atS). carId 0 = the longest-stood car at that moment.
import { readFileSync } from 'node:fs';
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { LONG_PROTOCOL } from '../../resources/js/sim/batchSchedule.js';
import { EVENING_PROFILE } from '../../resources/js/sim/demandProfile.js';
import { AFTERMATH_REACH_M } from '../../resources/js/sim/lockupWatch.js';

const [controllerMode, powerState, seedArg, giveUpArg, warmupArg, carIdArg, atList] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const chainLen = Number(opt('chain', 40));
const cfg = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
const ats = atList.split(',').map(Number).sort((a, b) => a - b);
const stopAtS = ats.at(-1);
const r1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);

class Stop extends Error {}
let ai = 0;
const tick = SimulationEngine.prototype.tick;
SimulationEngine.prototype.tick = function (dt) {
    tick.call(this, dt);
    while (ai < ats.length && this.simTimeS >= ats[ai] - 1e-9) dump(this, ats[ai++]);
    if (ai >= ats.length) throw new Stop();
};

function dump(e, atS) {
    const w = e.lockupWatch;
    const point = (id) => e.nodesInfo.get(id)?.node.point;
    const nearestJam = (id) => {
        const at = point(id);
        let best = null;
        for (const jam of w.darkJamNodeIds) {
            const p = point(jam);
            const d = at && p ? Math.hypot(p.x - at.x, p.y - at.y) : Infinity;
            if (!best || d < best.d) best = { jam, d: Math.round(d) };
        }
        return best;
    };
    const cars = w._liveCars();
    const waitsOn = new Map(cars.map((c) => [c.car, c.waitsOn]));
    const still = (c) => e.simTimeS - (w.stillSinceS.get(c.id) ?? e.simTimeS);
    let start = cars.find((c) => c.car.id === Number(carIdArg))?.car;
    if (!start) start = cars.map((c) => c.car).sort((a, b) => still(b) - still(a))[0];
    console.log(`\n=== t=${atS} s power=${e.snapshot().powerState} darkSpans=${JSON.stringify(w.darkSpans)}`);
    console.log(`darkJamNodeIds (${w.darkJamNodeIds.size}): ${[...w.darkJamNodeIds].join(', ')}`);
    const seen = new Set();
    for (let car = start, i = 0; car && !seen.has(car) && i < chainLen; car = waitsOn.get(car), i += 1) {
        seen.add(car);
        const d = w._describe(car);
        const plan = car.turnPlan;
        console.log(JSON.stringify({
            i, id: car.id, at: d.place, node: d.nodeId, v: r1(car.speedMps), still: r1(still(car)),
            jam: nearestJam(d.nodeId), plan: plan ? { nodeId: plan.nodeId, blockedS: plan.blockedSinceS != null ? r1(e.simTimeS - plan.blockedSinceS) : null } : null,
            exitHeld: [...e.nodesInfo.values()].some((info) => info.roundaboutExitHeld?.has(car)) || undefined,
        }));
    }
    if (waitsOn.get([...seen].at(-1)) && seen.has(waitsOn.get([...seen].at(-1)))) console.log(`chain closes on car ${waitsOn.get([...seen].at(-1)).id} (cycle)`);
    const ringId = opt('ring', null);
    if (ringId) dumpRing(e, ringId, start, still);
    console.log(`report: ${JSON.stringify(w.report(), (k, v) => (k === 'byNode' ? undefined : v))}`);
    console.log(`AFTERMATH_REACH_M=${AFTERMATH_REACH_M}`);
}

/** --ring=<nodeId>: the roundabout's own state - who is let in, waiting, going round, and the probed car's way out. */
function dumpRing(e, ringId, car, still) {
    const info = e.nodesInfo.get(ringId);
    const brief = (c) => c && { id: c.id, at: e.lockupWatch._describe(c).place, v: r1(c.speedMps), still: r1(still(c)) };
    console.log(`ring ${ringId}: openTo=${JSON.stringify([...(info.roundaboutOpenTo ?? [])])} exitHeld=${JSON.stringify([...(info.roundaboutExitHeld ?? [])].map((c) => c.id))}`);
    console.log(`  waiting: ${JSON.stringify([...info.roundaboutWaiting].map(([c, s]) => ({ id: c.id, forS: r1(e.simTimeS - s) })))}`);
    console.log(`  occupants: ${JSON.stringify([...info.roundaboutOccupants.values()].map((o) => ({ ...brief(o.car), approach: o.approachId, entered: o.entered, sinceS: r1(e.simTimeS - o.releasedAtS) })))}`);
    console.log(`  on ring: ${JSON.stringify(e.turningCars.filter((c) => c.turnPath.ringNodeId === ringId).map((c) => ({ ...brief(c), lane: c.lane, road: e._roadName(c.road), alongM: r1(c.distanceM), pathM: r1(c.turnPath.lengthM), waitsOn: c.waitsOn?.car?.id ?? c.waitsOn?.id ?? (c.waitsOn ? Object.keys(c.waitsOn).join('|') : null) })))}`);
    if (!car || car.turnPath) return;
    const gate = [...info.arterialGates, ...info.crossGates].find((g) => g.approach && (g.carriageway ? g.carriageway.road : g.connector && e.connectorDirs.get(g.connector.id)[g.dirKey].road) === car.road);
    console.log(`  car ${car.id}: released=${car.releasedNodeIds.has(ringId)} toStopM=${gate ? r1(gate.stopLineDistanceM - car.distanceM) : '?'} movement=${car.turnPlan?.movement} option=${car.turnPlan?.option ? 'yes' : 'none'} v=${car.speedMps}`);
    if (!gate) return;
    const target = e._roundaboutTarget(car, gate);
    if (!target) return;
    const mouthAtM = target.centreM + info.node.roundabout.mouthM;
    const lane = target.lanes[target.laneIndex];
    const beyond = lane.cars.filter((c) => c.distanceM > target.centreM).sort((a, b) => a.distanceM - b.distanceM);
    console.log(`  target ${e._roadName(target.road)} lane ${target.laneIndex}: exitFull=${e._roundaboutExitFull(info.node, target, car)} mouthAtM=${r1(mouthAtM)} tail=${JSON.stringify(beyond.slice(0, 4).map((c) => ({ ...brief(c), m: r1(c.distanceM - c.lengthM / 2) })))}`);
}

try {
    runHeadless({
        seed: Number(seedArg), controllerMode, sensorMode: controllerMode === 'fixed' ? null : 'inductive_loop', warmupTicks: Number(warmupArg),
        powerOutageStartTick: powerState === 'load_shedding' ? LONG_PROTOCOL.powerOutageStartTick : null,
        powerOutageEndTick: powerState === 'load_shedding' ? LONG_PROTOCOL.powerOutageEndTick : null,
        rollingSchedule: powerState === 'rolling_blackout' ? LONG_PROTOCOL.rollingSchedule : null,
        corridorConfig: cfg, durationTicks: LONG_PROTOCOL.measuredTicks, dt: 0.1, routingMode: 'destination',
        entryBacklogBalkS: Number(giveUpArg) * 60,
        demandProfile: { profile: EVENING_PROFILE, startClockS: LONG_PROTOCOL.startClockS }, sampleEverySeconds: LONG_PROTOCOL.sampleEverySeconds,
    });
} catch (err) {
    if (!(err instanceof Stop)) throw err;
}
console.log(`\nstopped at ${stopAtS} s`);
