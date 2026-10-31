// Browser bundle entry: longlockprobe.mjs's waits-on chain dump, run inside Chromium's V8. A /results batch row is only
// reproducible in the browser engine (Node's V8 drifts on some runs), so a stuck car seen in the batch is probed here.
// Driven by scripts/preview/browserprobe.mjs.
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { SimulationEngine } from '../../resources/js/sim/engine.js';
import { LONG_PROTOCOL } from '../../resources/js/sim/batchSchedule.js';
import { EVENING_PROFILE } from '../../resources/js/sim/demandProfile.js';

const r1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);

window.probeLongRun = (raw, cfg, powerState, carId, ats, { chain = 25, ring = null, stop = null } = {}) => {
    const lines = [];
    const log = (line) => lines.push(line);
    for (const street of [...(cfg.arterials ?? []), ...(cfg.connectors ?? [])]) {
        const o = raw.demandOverrides?.[street.id];
        if (o) street.demand = { ...street.demand, spawnRatePerLanePerMinMin: o.min, spawnRatePerLanePerMinMax: o.max, saturationFlowPerLanePerHour: o.saturationFlowPerLanePerHour };
    }
    const times = [...ats].sort((a, b) => a - b);

    function dumpRing(e, ringId, car, still) {
        const info = e.nodesInfo.get(ringId);
        const brief = (c) => c && { id: c.id, at: e.lockupWatch._describe(c).place, v: r1(c.speedMps), still: r1(still(c)) };
        log(`ring ${ringId}: openTo=${JSON.stringify([...(info.roundaboutOpenTo ?? [])])} exitHeld=${JSON.stringify([...(info.roundaboutExitHeld ?? [])].map((c) => c.id))}`);
        log(`  waiting: ${JSON.stringify([...info.roundaboutWaiting].map(([c, s]) => ({ id: c.id, forS: r1(e.simTimeS - s) })))}`);
        log(`  occupants: ${JSON.stringify([...info.roundaboutOccupants.values()].map((o) => ({ ...brief(o.car), approach: o.approachId, entered: o.entered, sinceS: r1(e.simTimeS - o.releasedAtS) })))}`);
        log(`  on ring: ${JSON.stringify(e.turningCars.filter((c) => c.turnPath.ringNodeId === ringId).map((c) => ({ ...brief(c), lane: c.lane, road: e._roadName(c.road), alongM: r1(c.distanceM), pathM: r1(c.turnPath.lengthM) })))}`);
        if (!car || car.turnPath) return;
        const gate = [...info.arterialGates, ...info.crossGates].find((g) => g.approach && (g.carriageway ? g.carriageway.road : g.connector && e.connectorDirs.get(g.connector.id)[g.dirKey].road) === car.road);
        log(`  car ${car.id}: released=${car.releasedNodeIds.has(ringId)} toStopM=${gate ? r1(gate.stopLineDistanceM - car.distanceM) : '?'} movement=${car.turnPlan?.movement} option=${car.turnPlan?.option ? 'yes' : 'none'} v=${car.speedMps} plan=${JSON.stringify(car.turnPlan ? { nodeId: car.turnPlan.nodeId, movement: car.turnPlan.movement, exit: car.turnPlan.exitRoadId ?? car.turnPlan.toRoadId ?? null } : null)}`);
        if (!gate) return;
        const target = e._roundaboutTarget(car, gate);
        if (!target) {
            log('  no roundabout target');
            return;
        }
        const lane = target.lanes[target.laneIndex];
        const beyond = lane.cars.filter((c) => c.distanceM > target.centreM).sort((a, b) => a.distanceM - b.distanceM);
        log(`  target ${e._roadName(target.road)} lane ${target.laneIndex}: exitFull=${e._roundaboutExitFull(info.node, target, car)} mouthAtM=${r1(target.centreM + info.node.roundabout.mouthM)} tail=${JSON.stringify(beyond.slice(0, 4).map((c) => ({ ...brief(c), m: r1(c.distanceM - c.lengthM / 2) })))}`);
    }

    /** A stop street's state: the minor queue's clock and lock, and every arterial car _arterialBlocksMinorStop() looks at. */
    function dumpStop(e, nodeId, still) {
        const info = e.nodesInfo.get(nodeId);
        const queued = e._allWayStopQueuedCars(info, 1);
        log(`stop ${nodeId}: type=${info.controllerType} lockedUntil=${r1(info.allWayStopLockedUntilS - e.simTimeS)} leg1=${JSON.stringify(info.allWayStopLegs?.[1])} blocks=${e._arterialBlocksMinorStop(info)} crossW=${info.node.crossRoadWidthM}`);
        log(`  minor front cars: ${JSON.stringify(queued.map((c) => ({ id: c.id, at: e.lockupWatch._describe(c).place, released: c.releasedNodeIds.has(nodeId), plan: c.turnPlan?.movement, still: r1(still(c)) })))}`);
        info.crossGates.forEach((gate, gi) => {
            const lanes = e.connectorState.get(gate.connector.id)[gate.dirKey].lanes;
            lanes.forEach((lane, li) => {
                const near = lane.cars.filter((c) => gate.stopLineDistanceM - c.distanceM < 40 && gate.stopLineDistanceM - c.distanceM > -30);
                if (near.length) log(`  cross gate ${gi} lane ${li} stopLine=${r1(gate.stopLineDistanceM)}: ${JSON.stringify(near.map((c) => ({ id: c.id, toStopM: r1(gate.stopLineDistanceM - c.distanceM), v: r1(c.speedMps), released: c.releasedNodeIds.has(nodeId), plan: c.turnPlan?.nodeId === nodeId ? c.turnPlan.movement : null, still: r1(still(c)) })))}`);
            });
        });
        info.arterialGates.forEach((gate, gi) => {
            e._gateLanes(gate).forEach((lane, li) => {
                const near = lane.cars.filter((c) => gate.stopLineDistanceM - c.distanceM < 60 && gate.stopLineDistanceM - c.distanceM > -info.node.crossRoadWidthM - 5);
                if (near.length) log(`  arterial gate ${gi} lane ${li}: ${JSON.stringify(near.map((c) => ({ id: c.id, at: e.lockupWatch._describe(c).place, toStopM: r1(gate.stopLineDistanceM - c.distanceM), v: r1(c.speedMps), plan: c.turnPlan?.nodeId === nodeId ? c.turnPlan.movement : null, still: r1(still(c)), waitsOn: e.lockupWatch._liveCars().find((x) => x.car === c)?.waitsOn?.id ?? null })))}`);
            });
        });
        if (info.controllerType === 'allWayStop') {
            const gateName = (gate) => `${gate.phase === 0 ? 'art' : 'cross'}:${gate.carriageway ? e._roadName(gate.carriageway.road) : gate.connector?.id + ':' + gate.dirKey}`;
            log(`  legs: ${JSON.stringify([...info.allWayStopLegs].map(([gate, leg]) => ({ gate: gateName(gate), sinceS: leg.arrivedAtS == null ? null : r1(e.simTimeS - leg.arrivedAtS), dwellS: r1(leg.requiredDwellS) })))}`);
            log(`  occupants: ${JSON.stringify([...info.allWayStopOccupants.values()].map((o) => ({ id: o.car.id, gate: gateName(o.gate), sinceS: r1(e.simTimeS - o.releasedAtS), entered: o.entered, seenTurning: o.seenTurning })))}`);
            for (const [phase, gates] of [[0, info.arterialGates], [1, info.crossGates]]) {
                for (const gate of gates) {
                    const front = e._allWayStopQueuedAtGate(info, gate, phase);
                    log(`  front ${gateName(gate)}: ${JSON.stringify(front.map((c) => ({ id: c.id, released: c.releasedNodeIds.has(nodeId), exitClear: e._allWayStopExitClear(info, gate, phase, c), plan: c.turnPlan?.nodeId === nodeId ? c.turnPlan.movement : null, v: r1(c.speedMps), still: r1(still(c)) })))}`);
                }
            }
        }
        const turning = e.turningCars.filter((c) => c.turnPath?.nodeId === nodeId || c.turnPlan?.nodeId === nodeId && c.turnPath);
        log(`  turning at node: ${JSON.stringify(turning.map((c) => ({ id: c.id, road: e._roadName(c.road), along: r1(c.distanceM), path: r1(c.turnPath.lengthM), v: r1(c.speedMps), still: r1(still(c)) })))}`);
    }

    function dump(e, atS) {
        const w = e.lockupWatch;
        const cars = w._liveCars();
        const waitsOn = new Map(cars.map((c) => [c.car, c.waitsOn]));
        const still = (c) => e.simTimeS - (w.stillSinceS.get(c.id) ?? e.simTimeS);
        let start = cars.find((c) => c.car.id === carId)?.car;
        log(`\n=== t=${atS} s power=${e.snapshot().powerState} target ${carId} ${start ? 'found' : 'NOT live'}`);
        if (!start) start = cars.map((c) => c.car).sort((a, b) => still(b) - still(a))[0];
        const seen = new Set();
        for (let car = start, i = 0; car && !seen.has(car) && i < chain; car = waitsOn.get(car), i += 1) {
            seen.add(car);
            const d = w._describe(car);
            const plan = car.turnPlan;
            log(JSON.stringify({
                i, id: car.id, at: d.place, node: d.nodeId, v: r1(car.speedMps), still: r1(still(car)),
                plan: plan ? { nodeId: plan.nodeId, movement: plan.movement, blockedS: plan.blockedSinceS != null ? r1(e.simTimeS - plan.blockedSinceS) : null } : null,
                exitHeld: [...e.nodesInfo.values()].some((info) => info.roundaboutExitHeld?.has(car)) || undefined,
            }));
        }
        const last = [...seen].at(-1);
        if (waitsOn.get(last) && seen.has(waitsOn.get(last))) log(`chain closes on car ${waitsOn.get(last).id} (cycle)`);
        if (ring) dumpRing(e, ring, start, still);
        if (stop) dumpStop(e, stop, still);
    }

    class Stop extends Error {}
    let ai = 0;
    const tick = SimulationEngine.prototype.tick;
    SimulationEngine.prototype.tick = function (dt) {
        tick.call(this, dt);
        while (ai < times.length && this.simTimeS >= times[ai] - 1e-9) dump(this, times[ai++]);
        if (ai >= times.length) throw new Stop();
    };
    try {
        runHeadless({
            seed: raw.seed,
            controllerMode: raw.controllerMode,
            sensorMode: raw.sensorMode,
            warmupTicks: raw.warmupTicks,
            powerOutageStartTick: powerState === 'load_shedding' ? LONG_PROTOCOL.powerOutageStartTick : null,
            powerOutageEndTick: powerState === 'load_shedding' ? LONG_PROTOCOL.powerOutageEndTick : null,
            rollingSchedule: powerState === 'rolling_blackout' ? LONG_PROTOCOL.rollingSchedule : null,
            corridorConfig: cfg,
            durationTicks: LONG_PROTOCOL.measuredTicks,
            dt: 0.1,
            routingMode: raw.routingMode,
            demandProfile: { profile: EVENING_PROFILE, startClockS: LONG_PROTOCOL.startClockS },
            sampleEverySeconds: LONG_PROTOCOL.sampleEverySeconds,
        });
    } catch (error) {
        if (!(error instanceof Stop)) throw error;
    } finally {
        SimulationEngine.prototype.tick = tick;
    }
    return lines;
};
