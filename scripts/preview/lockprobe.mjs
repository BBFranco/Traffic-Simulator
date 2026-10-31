// Replays one /results batch run and, at chosen sim times, prints a car's waits-on chain (lockupWatch.js's graph) with
// each car's road, lane, position, speed, turn plan and what holds it.
// node scripts/preview/lockprobe.mjs <raw_config.json> <controller> <sensor|-> <power> <seed> <carId> <simS,simS,...> [--chain=12]
//   simS: engine seconds INCLUDING warm-up (lockup report atS). carId 0 = the longest-stood car at that moment.
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../resources/js/sim/corridor.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { MEASURED_TICKS, POWER_OUTAGE_START_TICK, POWER_OUTAGE_END_TICK, ROLLING_SCHEDULE } from '../../resources/js/sim/batchSchedule.js';

const [rawPath, controllerMode, sensorArg, powerState, seedArg, carIdArg, atList] = process.argv.slice(2);
const opt = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const chainLen = Number(opt('chain', 12));
const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
const cfg = JSON.parse(readFileSync(new URL('../../corridors/hatfield-realistic.json', import.meta.url), 'utf8'));
for (const street of [...(cfg.arterials ?? []), ...(cfg.connectors ?? [])]) {
    const o = raw.demandOverrides?.[street.id];
    if (o) street.demand = { ...street.demand, spawnRatePerLanePerMinMin: o.min, spawnRatePerLanePerMinMax: o.max, saturationFlowPerLanePerHour: o.saturationFlowPerLanePerHour };
}
// ASSIGNMENT='{}' switches capacity-aware route choice on, as in batchreplay.mjs.
if (process.env.ASSIGNMENT) cfg.routing.assignment = process.env.ASSIGNMENT === 'off' ? null : JSON.parse(process.env.ASSIGNMENT);
const dt = 0.1;
const layout = buildLayout(cfg);
const e = new SimulationEngine(layout);
const arterialModes = {};
const demand = {};
for (const a of layout.arterials) { arterialModes[a.id] = controllerMode; demand[a.id] = a.demand.spawnRatePerLanePerMin; }
for (const c of layout.connectors) demand[c.id] = c.demand.spawnRatePerLanePerMin;
e.reset({
    seed: Number(seedArg), arterialModes, demand, sensorMode: sensorArg === '-' ? null : sensorArg, batteryBackedSensors: true,
    power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 }, routingMode: raw.routingMode,
    websterTurnWeight: false, coordination: {},
});
const warm = raw.warmupTicks;
const ats = atList.split(',').map(Number).sort((a, b) => a - b);
let darkKey = '';
let ai = 0;
const r1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
const describe = (car) => {
    const plan = car.turnPlan;
    const opt = plan?.option;
    return {
        id: car.id, at: e.lockupWatch._describe(car).place, node: e.lockupWatch._nearestNodeId(car), v: r1(car.speedMps),
        still: r1(e.simTimeS - (e.lockupWatch.stillSinceS.get(car.id) ?? e.simTimeS)),
        plan: plan ? { turn: plan.turn ?? plan.kind, nodeId: plan.nodeId, to: opt && (opt.carriagewayId ?? `${opt.connectorId}:${opt.dirKey}`), toLane: opt?.laneIndex ?? opt?.lane, entryM: r1(opt?.entryDistanceM), blockedS: plan.blockedSinceS != null ? r1(e.simTimeS - plan.blockedSinceS) : null, held: plan.heldSeenTick } : null,
        dest: car.trip?.dest ?? car.trip?.destination ?? null, joinSlot: car.joinSlot?.key ?? null, letIn: car.letIn ?? car.letInFor ?? null,
        waitsOn: car.waitsOn ? (car.waitsOn.car?.id ?? car.waitsOn.id ?? Object.keys(car.waitsOn).join('|')) : null,
    };
};
for (let tick = 0; ai < ats.length; tick += 1) {
    const m = tick - warm;
    if (m === 0) e.resetStats();
    if (powerState === 'load_shedding' && m === POWER_OUTAGE_START_TICK) e.setManualLoadShedding(true);
    if (powerState === 'load_shedding' && m === POWER_OUTAGE_END_TICK) e.setManualLoadShedding(false);
    if (powerState === 'rolling_blackout' && m >= 0) {
        const zones = ROLLING_SCHEDULE.filter((w) => m >= w.fromTick && m < w.toTick).flatMap((w) => w.zones);
        const key = [...new Set(zones)].sort().join(',');
        if (key !== darkKey) { e.setZoneDark(zones); darkKey = key; }
    }
    e.tick(dt);
    while (ai < ats.length && e.simTimeS >= ats[ai] - 1e-9) {
        const cars = e.lockupWatch._liveCars();
        const waitsOn = new Map(cars.map((c) => [c.car, c.waitsOn]));
        let start = cars.find((c) => c.car.id === Number(carIdArg))?.car;
        const headRoad = opt('head', null);
        if (headRoad) {
            const stood = cars.map((c) => c.car).filter((c) => !c.turnPath && e._roadName(c.road) === headRoad && c.speedMps < 0.1);
            start = stood.sort((a, b) => b.distanceM - a.distanceM)[0];
            const road = start?.road;
            console.log('head road', road?.id ?? road?.key ?? Object.keys(road ?? {}).slice(0, 8).join('|'), 'len', r1(road?.lengthM), 'nodes', JSON.stringify((e.layout?.nodes ?? []).length));
        }
        if (!start) {
            const still = (c) => e.simTimeS - (e.lockupWatch.stillSinceS.get(c.id) ?? e.simTimeS);
            start = cars.map((c) => c.car).sort((a, b) => still(b) - still(a))[0];
        }
        console.log(`\n=== t=${ats[ai]} s (measured ${(ats[ai] - warm * dt).toFixed(0)} s) power=${e.snapshot().powerState}`);
        if (process.argv.includes('--roads')) {
            const per = new Map();
            for (const { car } of cars) {
                const k = car.turnPath ? `turning@${e.lockupWatch._nearestNodeId(car)}` : `${e.routingModel?.roadKeyByRoad.get(car.road) ?? e._roadName(car.road)} l${car.lane}`;
                const st = per.get(k) ?? { n: 0, stood: 0, maxStill: 0, lo: 1e9, hi: -1 };
                const still = e.simTimeS - (e.lockupWatch.stillSinceS.get(car.id) ?? e.simTimeS);
                st.n += 1; if (car.speedMps < 0.1) { st.stood += 1; st.lo = Math.min(st.lo, Math.round(car.distanceM)); st.hi = Math.max(st.hi, Math.round(car.distanceM)); }
                st.maxStill = Math.max(st.maxStill, Math.round(still));
                per.set(k, st);
            }
            console.log([...per].filter(([, st]) => st.stood >= 4).sort((a, b) => b[1].stood - a[1].stood).slice(0, 18).map(([k, st]) => `  ${k}: ${st.stood}/${st.n} stood @${st.lo}-${st.hi} m, max ${st.maxStill}s`).join('\n'));
        }
        const nodeArg = opt('node', null);
        if (nodeArg && e.nodesInfo.get(nodeArg)?.controllerType === "roundabout") {
            const info = e.nodesInfo.get(nodeArg);
            const arr = e._roundaboutArrivals(info).map((a) => ({ id: a.car.id, appr: a.approachId, lane: a.car.lane, d: r1(a.car.distanceM), v: r1(a.car.speedMps), to: a.car.turnPlan?.option ? (a.car.turnPlan.option.carriagewayId ?? `${a.car.turnPlan.option.connectorId}:${a.car.turnPlan.option.dirKey}`) : a.car.turnPlan?.movement, waited: info.roundaboutWaiting.has(a.car) ? r1(e.simTimeS - info.roundaboutWaiting.get(a.car)) : null, exitHeld: info.roundaboutExitHeld?.has(a.car) ?? null, noGate: !a.gate }));
            console.log('arrivals', JSON.stringify(arr));
            console.log('openTo', JSON.stringify([...(info.roundaboutOpenTo ?? [])]), 'approaches', JSON.stringify(info.node.approaches.map((a) => a.id)));
            console.log('occupants', JSON.stringify([...info.roundaboutOccupants.values()].map((o) => ({ id: o.car.id, appr: o.approachId, entered: o.entered, age: r1(e.simTimeS - o.releasedAtS), v: r1(o.car.speedMps), on: o.car.turnPath ? 'path' : e._roadName(o.car.road) }))));
            const ring = e.turningCars.filter((c) => c.turnPath.ringNodeId === nodeArg).map((c) => ({ id: c.id, d: r1(c.distanceM), entryAt: r1(c.turnPath.ringEntryAtM), exitAt: r1(c.turnPath.ringExitAtM), len: r1(c.turnPath.lengthM), v: r1(c.speedMps), to: e._roadName(c.turnPath.road ?? c.road), waitsOn: c.waitsOn?.car?.id ?? c.waitsOn?.id ?? (c.waitsOn ? 'exit' : null) }));
            console.log('ring', JSON.stringify(ring));
        }
        const awsNode = opt('aws', null);
        if (awsNode) {
            const info = e.nodesInfo.get(awsNode);
            console.log('aws', info.controllerType, 'occupants', JSON.stringify([...(info.allWayStopOccupants ?? new Map()).values()].map((o) => ({ id: o.car.id, age: r1(e.simTimeS - o.releasedAtS), v: r1(o.car.speedMps), d: r1(o.car.distanceM), seenTurning: o.seenTurning }))));
            for (const [gate, leg] of info.allWayStopLegs instanceof Map ? info.allWayStopLegs : []) {
                const lanes = gate.phase === 0 || gate.carriageway ? e._gateLanes(gate) : e.connectorState.get(gate.connector.id)[gate.dirKey].lanes;
                const front = lanes.map((l) => l.cars.filter((c) => c.distanceM < gate.stopLineDistanceM + 1).sort((a, b) => b.distanceM - a.distanceM)[0]).filter(Boolean).map((c) => ({ id: c.id, toStop: r1(gate.stopLineDistanceM - c.distanceM), v: r1(c.speedMps), stoppedNow: c.stoppedNow, rel: c.releasedNodeIds.has(awsNode) }));
                console.log('  gate', gate.approach?.id ?? gate.id, 'phase', gate.phase, 'arrivedAgo', leg.arrivedAtS == null ? null : r1(e.simTimeS - leg.arrivedAtS), 'dwell', r1(leg.requiredDwellS), 'front', JSON.stringify(front));
            }
            const car = cars.find((c) => c.car.id === Number(carIdArg))?.car;
            if (car) {
                const lane = car.road && e._signalAheadFor && car.gates ? null : null;
                console.log('  car', car.id, 'stoppedNow', car.stoppedNow, 'released', [...car.releasedNodeIds].slice(-4).join(','), 'startup', r1(car.startupDelayS), r1(car.startupTimerS), 'turnPlan', JSON.stringify(car.turnPlan && { movement: car.turnPlan.movement, nodeId: car.turnPlan.nodeId, blocked: car.turnPlan.blockedSinceS }));
            }
        }
        if (process.argv.includes('--obstacles')) {
            const car = cars.find((c) => c.car.id === Number(carIdArg))?.car;
            const cw = car && [...e.carriagewayState.entries()].find(([, st]) => st.lanes.some((l) => l.cars.includes(car)));
            if (cw) {
                const carriageway = e.carriagewaysById.get(cw[0]);
                const { gates } = carriageway;
                const state = cw[1];
                const lane = state.lanes[car.lane];
                const idx = [...lane.cars].sort((a, b) => b.distanceM - a.distanceM).indexOf(car);
                const b = (o) => (o ? JSON.stringify({ d: r1(o.distanceM - car.distanceM), v: r1(o.speedMps), sig: o.isSignal ?? undefined, node: o.nodeId, id: o.id }) : '-');
                const parts = {
                    real: idx > 0 ? [...lane.cars].sort((a, b2) => b2.distanceM - a.distanceM)[idx - 1] : null,
                    signal: e._signalAheadFor(gates, car), join: idx === 0 ? e._joinObstacle(carriageway.id, car) : null,
                    entryTail: e._roundaboutEntryTail(e._nearestNodeAhead(gates, car), car), driveway: e._drivewayHold(car), letIn: e._letInHold(car, gates),
                    peel: e._peelHold(carriageway.id, state, lane, car), runOut: e._runOutHold(state, car), pocket: e._pocketHold(e._nearestNodeAhead(gates, car), car),
                };
                console.log('  obstacles', cw[0], 'len', r1(carriageway.lengthM), Object.entries(parts).map(([k, o]) => `${k}=${b(o)}`).join(' '));
            } else if (car) console.log('  obstacles: car not on a carriageway');
        }
        if (process.argv.includes('--letin')) {
            const car = cars.find((c) => c.car.id === Number(carIdArg))?.car;
            const w = car && (e.letIn.get(car.road)?.get(car.lane) ?? []).find((x) => e._letInActive(x));
            if (w) {
                const asker = cars.find((c) => c.car.id === w.carId)?.car;
                console.log('  letIn', JSON.stringify({ asker: w.carId, exitM: r1(w.exitDistanceM), untilIn: r1(w.untilS - e.simTimeS), heldPlan: !!w.heldPlan, planBlocked: w.heldPlan?.blockedSinceS != null ? r1(e.simTimeS - w.heldPlan.blockedSinceS) : null, seenAgo: w.heldPlan ? e.tickNo - w.heldPlan.heldSeenTick : null, active: e._letInActive(w) }),
                    'askerNow', asker ? JSON.stringify(describe(asker)) : 'not found (gone, or a driveway id)');
                const room = e.carriagewayState.get([...e.carriagewayState.keys()].find((k) => e.carriagewaysById.get(k).road === car.road))?.lanes[car.lane].cars.filter((c) => Math.abs(c.distanceM - w.exitDistanceM) < 12).map((c) => `${c.id}@${r1(c.distanceM)} v${r1(c.speedMps)}`);
                console.log('  in the room', JSON.stringify(room));
            } else console.log('  letIn none on its own lane');
            for (const [road, lanes] of e.letIn) for (const [li, ws] of lanes) for (const w2 of ws) if (w2.carId === Number(carIdArg)) console.log('  it asked', e._roadName(road), 'lane', li, JSON.stringify({ exitM: r1(w2.exitDistanceM), untilIn: r1(w2.untilS - e.simTimeS), active: e._letInActive(w2) }));
        }
        if (process.argv.includes('--merge')) {
            const car = cars.find((c) => c.car.id === Number(carIdArg))?.car;
            for (const [key, join] of e.joinsFrom) {
                if (join.toAtM == null || !join.from.lanes().some((l) => l.cars.includes(car))) continue;
                const slot = e._joinTargetSlot(join, car);
                const lane = join.to.lanes()[slot];
                const near = lane.cars.filter((c) => Math.abs(c.distanceM - join.toAtM) < 40).map((c) => `${c.id}@${r1(c.distanceM - join.toAtM)} v${r1(c.speedMps)}`);
                const turning = e.turningCars.filter((c) => c.road === join.to.road && c.turnPath && !c.turnPath.driveway && Math.abs(c.turnPath.exitDistanceM - join.toAtM) < 25).map((c) => `${c.id} d${r1(c.distanceM)}/${r1(c.turnPath.lengthM)} v${r1(c.speedMps)} lanes${JSON.stringify(e._turnTargetLanes(c.turnPath))}`);
                console.log('  merge', key, 'toAtM', r1(join.toAtM), 'slot', slot, 'carToEnd', r1(join.from.lengthM - car.distanceM), 'heldFor', car.joinHeldSinceS != null ? r1(e.simTimeS - car.joinHeldSinceS) : null, '\n    lane near merge', JSON.stringify(near), '\n    turning into', JSON.stringify(turning), '\n    obstacle', JSON.stringify(e._joinObstacle(key, car)));
            }
        }
        const seen = new Set();
        for (let c = start, n = 0; c && !seen.has(c) && n < chainLen; c = waitsOn.get(c), n += 1) {
            seen.add(c);
            console.log(JSON.stringify(describe(c)));
        }
        ai += 1;
    }
}
