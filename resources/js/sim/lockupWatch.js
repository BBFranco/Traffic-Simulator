/**
 * lockupWatch.js - names a gridlock in the run it happens in, instead of
 * leaving it to surface later as a wide confidence interval.
 *
 * Read-only: it never moves a car or draws from a random stream, so a run's
 * trajectory is the same with or without it.
 *
 * Once a simulated second it records how long every vehicle has been standing
 * still, and looks for a cycle in the waits-on graph (A waits on B ... waits on
 * A) among cars that have stood for CYCLE_HELD_S. Max wait alone can't tell a
 * saturation tail from a lockup: a saturated queue still creeps forward every
 * cycle, a locked one never does.
 *
 * Waits-on edges: a lane car waits on the car just ahead in its lane; a car
 * turning through a junction or round a roundabout on whatever its step
 * followed (engine.js's `car.waitsOn`), the car in the way where its exit is
 * blocked included; a car held at a roundabout's yield line because its way
 * out is backed up, on the car blocking that exit. A lockup that runs through
 * a kind of wait not listed here still shows as a long standstill - the cycle
 * is the naming aid, the standstill the catch-all.
 */
import { carRenderPoint } from './car.js';

/**
 * A vehicle stood still this long is a lockup. Not 120 s: a saturated roundabout can fill, stall and clear by itself,
 * and a car at its yield line waited 154 s through that (fixed-time, seed 20260115, herold_lunnon). The camera seed's
 * real lockup stood 3,150 s.
 */
export const LOCKUP_STILL_S = 300;
/** Cars in a waits-on cycle that have all stood this long are a lockup - the cycle names it before the standstill limit. */
export const CYCLE_HELD_S = 60;
/** Below this a car counts as standing still. */
const STILL_SPEED_MPS = 0.1;
const CHECK_EVERY_S = 1;
/** A lane car further than this behind the one ahead is waiting on something else (a signal), not on that car. */
const LANE_FOLLOW_GAP_M = 15;
/** engine.js's own clearances: a roundabout exit's run-out and the room a car needs beyond its neighbours' lengths. */
const ROUNDABOUT_EXIT_RUN_M = 3;
const SPAWN_CLEARANCE_M = 4;

export class LockupWatch {
    constructor(engine) {
        this.engine = engine;
        this.stillSinceS = new Map();
        this.nextCheckS = 0;
        this.resetRecord();
    }

    /** Starts the run's record over (the measured window) - cars already standing keep their clock. */
    resetRecord() {
        this.longest = null;
        this.firstCycle = null;
        this.cycleKeys = new Set();
    }

    observe() {
        const nowS = this.engine.simTimeS;
        if (nowS < this.nextCheckS) return;
        this.nextCheckS = nowS + CHECK_EVERY_S;

        const cars = this._liveCars();
        const stillSinceS = new Map();
        for (const { car } of cars) {
            if (car.speedMps >= STILL_SPEED_MPS) continue;
            stillSinceS.set(car.id, this.stillSinceS.get(car.id) ?? nowS);
        }
        this.stillSinceS = stillSinceS;

        for (const { car } of cars) {
            const stillS = nowS - (stillSinceS.get(car.id) ?? nowS);
            if (stillS > 0 && stillS > (this.longest?.seconds ?? 0)) this.longest = { seconds: stillS, ...this._describe(car), atS: nowS };
        }
        this._findCycles(cars, nowS);
    }

    /** What a batch run stores (diagnostics.lockup) - rounded, plain data. */
    report() {
        const longestStillS = this.longest ? Math.round(this.longest.seconds) : 0;
        return {
            longestStillS,
            longestStill: this.longest && { carId: this.longest.carId, nodeId: this.longest.nodeId, place: this.longest.place, atS: Math.round(this.longest.atS) },
            cycles: this.cycleKeys.size,
            firstCycle: this.firstCycle,
            isLockup: longestStillS >= LOCKUP_STILL_S || this.firstCycle !== null,
        };
    }

    /** Every vehicle on the network, with what it waits on in its own lane (the car just ahead, if close). */
    _liveCars() {
        const { engine } = this;
        const result = [];
        const addLane = (lane) => {
            const sorted = [...lane.cars].sort((a, b) => b.distanceM - a.distanceM);
            sorted.forEach((car, i) => {
                const ahead = sorted[i - 1];
                const close = ahead && ahead.distanceM - car.distanceM - (ahead.lengthM + car.lengthM) / 2 < LANE_FOLLOW_GAP_M;
                result.push({ car, waitsOn: close ? ahead : null });
            });
        };
        for (const state of engine.carriagewayState.values()) state.lanes.forEach(addLane);
        for (const state of engine.connectorState.values()) {
            state.fwd.lanes.forEach(addLane);
            state.rev.lanes.forEach(addLane);
        }
        for (const car of engine.turningCars) result.push({ car, waitsOn: this._turningWaitsOn(car) });
        this._addRoundaboutExitWaits(result);
        return result;
    }

    /** The car a turning car's last step followed - a car directly, or the one blocking its exit. */
    _turningWaitsOn(car) {
        const ahead = car.waitsOn;
        if (!ahead) return null;
        if (ahead.car) return ahead.car;
        if (ahead.exitLanes) return blockerAt(ahead.exitLanes[car.lane], ahead.exitDistanceM, car.lengthM);
        return typeof ahead.id === 'number' ? ahead : null;
    }

    /** A car held at a roundabout's yield line because its way out is backed up waits on whoever blocks that exit. */
    _addRoundaboutExitWaits(result) {
        const { engine } = this;
        const byCar = new Map(result.map((entry) => [entry.car, entry]));
        for (const info of engine.nodesInfo.values()) {
            if (info.controllerType !== 'roundabout' || !info.roundaboutExitHeld?.size) continue;
            for (const arrival of engine._roundaboutArrivals(info)) {
                const entry = byCar.get(arrival.car);
                if (!entry || !info.roundaboutExitHeld.has(arrival.car) || !arrival.gate) continue;
                const target = engine._roundaboutTarget(arrival.car, arrival.gate);
                if (!target) continue;
                const exitDistanceM = target.centreM + info.node.roundabout.radiusM + ROUNDABOUT_EXIT_RUN_M;
                entry.waitsOn = blockerAt(target.lanes[target.laneIndex], exitDistanceM, arrival.car.lengthM) ?? entry.waitsOn;
            }
        }
    }

    _findCycles(cars, nowS) {
        const held = (car) => nowS - (this.stillSinceS.get(car.id) ?? nowS) >= CYCLE_HELD_S;
        const next = new Map();
        for (const { car, waitsOn } of cars) if (waitsOn && held(car) && held(waitsOn)) next.set(car, waitsOn);

        const done = new Set();
        for (const start of next.keys()) {
            if (done.has(start)) continue;
            const path = [];
            const onPath = new Map();
            let car = start;
            while (car && !done.has(car) && !onPath.has(car)) {
                onPath.set(car, path.length);
                path.push(car);
                car = next.get(car);
            }
            if (car && onPath.has(car)) this._recordCycle(path.slice(onPath.get(car)), nowS);
            path.forEach((c) => done.add(c));
        }
    }

    _recordCycle(members, nowS) {
        const key = members.map((c) => c.id).sort((a, b) => a - b).join(',');
        if (this.cycleKeys.has(key)) return;
        this.cycleKeys.add(key);
        if (this.firstCycle) return;
        const described = members.map((car) => this._describe(car));
        this.firstCycle = {
            carIds: described.map((d) => d.carId),
            nodeIds: [...new Set(described.map((d) => d.nodeId))],
            places: described.map((d) => d.place),
            heldS: Math.round(Math.min(...members.map((car) => nowS - this.stillSinceS.get(car.id)))),
            atS: Math.round(nowS),
        };
    }

    /** Where a car is, readably, and the junction nearest it. */
    _describe(car) {
        const { engine } = this;
        const path = car.turnPath;
        const place = path?.driveway
            ? 'turning into a driveway'
            : path?.fromDriveway
              ? 'pulling out of a driveway'
              : path?.ringNodeId
                ? `round ${path.ringNodeId}`
                : path
                  ? `turning onto ${engine._roadName(car.road)}`
                  : `${engine._roadName(car.road)}, lane ${car.lane}, ${Math.round(car.distanceM)} m`;
        return { carId: car.id, nodeId: this._nearestNodeId(car), place };
    }

    _nearestNodeId(car) {
        const p = carRenderPoint(car);
        let best = null;
        for (const info of this.engine.nodesInfo.values()) {
            const d = Math.hypot(info.node.point.x - p.x, info.node.point.y - p.y);
            if (!best || d < best.d) best = { d, id: info.node.id };
        }
        return best?.id ?? null;
    }
}

/** The car in `lane` occupying the stretch a car of `lengthM` needs at `atM` - what a blocked turn or exit waits on. */
function blockerAt(lane, atM, lengthM) {
    let best = null;
    for (const car of lane?.cars ?? []) {
        const gap = Math.abs(car.distanceM - atM);
        if (gap < (car.lengthM + lengthM) / 2 + SPAWN_CLEARANCE_M && (!best || gap < best.gap)) best = { gap, car };
    }
    return best?.car ?? null;
}
