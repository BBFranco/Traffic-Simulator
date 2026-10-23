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
 * out is backed up, on the car blocking that exit; the front car at a
 * junction held for a blocked turn, on the car where it would land; the front
 * car at the end of a road, on the last car in the lane it joins.
 *
 * A long standstill is only a lockup if the queue ahead of it is stuck too:
 * following the waits-on chain from the car, every car on it has stood for
 * LOCKUP_STILL_S. Where something ahead still moves, the car is starved - a
 * side street that can't get into an arterial queue spilling back past it is
 * saturation, not a fault (Herold at Lynnwood under green wave after an
 * outage). Starved approaches are reported, but don't fail a batch.
 *
 * A lockup that STARTS while any junction is dark is gridlock under all-way
 * stops - a possible real outcome of a multi-hour outage, not necessarily a
 * software fault (dissertation plan step 7.6, Franco 2026-10-23). It is kept
 * apart (report().gridlock) and doesn't fail a batch; one that starts with
 * every junction lit is the fault isLockup reports, as before. A lockup
 * starts when the jam does: the earliest standstill on its waits-on chain (or
 * in its cycle) - a car that joins a dark-period jam after the power is back
 * is that jam, not a new one (long-outage pilot, 2026-10-23).
 *
 * Separately, a car that stands inside a junction box - past its stop line and
 * short of the far kerb, or on a turn path - for BOX_STUCK_S is recorded as
 * box-stuck (report().boxStuck), long before the lockup limit: Franco saw
 * southbound Duxbury cars stranded mid-junction at Lynnwood under a long
 * outage, with Lynnwood creeping in round them (2026-10-23). Reported only,
 * never a batch failure.
 */
import { carRenderPoint } from './car.js';

/**
 * A vehicle stood still this long, with everything ahead of it stuck as long, is a lockup - with something ahead moving,
 * a starved approach. Not 120 s: a saturated roundabout can fill, stall and clear by itself, and a car at its yield line
 * waited 154 s through that (fixed-time, seed 20260115, herold_lunnon). The camera seed's real lockup stood 3,150 s.
 */
export const LOCKUP_STILL_S = 300;
/** Cars in a waits-on cycle that have all stood this long are a lockup - the cycle names it before the standstill limit. */
export const CYCLE_HELD_S = 60;
/**
 * A chain must read stuck this many seconds running before it counts as locked. The car at a queue's head that is being
 * released - a turner that has just found its gap, still under STILL_SPEED_MPS for a second or two with nothing to wait
 * on - would otherwise flag the whole queue behind it as locked for the moment it takes to pull away.
 */
export const LOCK_CONFIRM_S = 10;
/**
 * A car standing this long inside a junction box is box-stuck. Above the longest signal cycle (the 120 s fallback): a
 * right-turner waiting in the box clears on the amber, so a lit junction never holds one there for a whole cycle.
 */
export const BOX_STUCK_S = 120;
/** Below this a car counts as standing still. */
const STILL_SPEED_MPS = 0.1;
const CHECK_EVERY_S = 1;
/** A lane car further than this behind the one ahead is waiting on something else (a signal), not on that car. */
const LANE_FOLLOW_GAP_M = 15;
/** engine.js's own clearances: a roundabout exit's run-out and the room a car needs beyond its neighbours' lengths. */
const ROUNDABOUT_EXIT_RUN_M = 3;
const SPAWN_CLEARANCE_M = 4;
/** A front car this close to the end of its road is waiting on the lane it joins. */
const JOIN_WAIT_REACH_M = 10;
/** A held turner waits on the nearest car from this far short of where it would land, onwards. */
const LANDING_REACH_M = 20;
const MAX_CHAIN = 500;

export class LockupWatch {
    constructor(engine) {
        this.engine = engine;
        this.stillSinceS = new Map();
        /** Car id -> when its waits-on chain first read stuck, for the cars whose chain still does. */
        this.stuckSinceS = new Map();
        this.nextCheckS = 0;
        this.resetRecord();
    }

    /** Starts the run's record over (the measured window) - cars already standing keep their clock. */
    resetRecord() {
        this.longest = null;
        this.longestLocked = null;
        this.longestLockedDark = null;
        this.longestStarved = null;
        this.firstCycle = null;
        this.firstCycleDark = null;
        this.cycleKeys = new Set();
        /** Box-stuck cars: their ids, how many per junction, and the longest such standstill. */
        this.boxStuckIds = new Set();
        this.boxStuckByNode = new Map();
        this.longestBoxStuck = null;
        /** [{ fromS, toS }] while any junction was dark (toS null while it still is) - what a lockup's start is classed against. */
        this.darkSpans = [];
    }

    /** Was any junction dark at sim time `atS` (to this watch's 1 s resolution)? */
    _darkAt(atS) {
        return this.darkSpans.some((span) => atS >= span.fromS && (span.toS == null || atS < span.toS));
    }

    observe() {
        const nowS = this.engine.simTimeS;
        if (nowS < this.nextCheckS) return;
        this.nextCheckS = nowS + CHECK_EVERY_S;

        const dark = (this.engine.darkNodes?.size ?? 0) > 0;
        const open = this.darkSpans.at(-1)?.toS === null ? this.darkSpans.at(-1) : null;
        if (dark && !open) this.darkSpans.push({ fromS: nowS, toS: null });
        else if (!dark && open) open.toS = nowS;

        const cars = this._liveCars();
        const stillSinceS = new Map();
        for (const { car } of cars) {
            if (car.speedMps >= STILL_SPEED_MPS) continue;
            stillSinceS.set(car.id, this.stillSinceS.get(car.id) ?? nowS);
        }
        this.stillSinceS = stillSinceS;

        const stillS = (car) => nowS - (stillSinceS.get(car.id) ?? nowS);
        const waitsOn = new Map(cars.map((entry) => [entry.car, entry.waitsOn]));
        const stuckSinceS = new Map();
        for (const { car } of cars) {
            const seconds = stillS(car);
            if (seconds > 0 && seconds > (this.longest?.seconds ?? 0)) this.longest = { seconds, ...this._describe(car), atS: nowS };
            if (seconds < LOCKUP_STILL_S) continue;
            const stuck = this._chainStuck(car, waitsOn, stillS);
            if (stuck) stuckSinceS.set(car.id, this.stuckSinceS.get(car.id) ?? nowS);
            // A chain that has only just read stuck is a release in progress, not yet a lockup.
            if (stuck && nowS - stuckSinceS.get(car.id) < LOCK_CONFIRM_S) continue;
            const key = stuck ? (this._darkAt(this._chainStartS(car, waitsOn, stillS, nowS)) ? 'longestLockedDark' : 'longestLocked') : 'longestStarved';
            if (seconds > (this[key]?.seconds ?? 0)) this[key] = { seconds, ...this._describe(car), atS: nowS };
        }
        this.stuckSinceS = stuckSinceS;
        this._findCycles(cars, nowS);
        this._findBoxStuck(cars, stillS, nowS);
    }

    /** What a batch run stores (diagnostics.lockup) - rounded, plain data. */
    report() {
        const plain = (record) => record && { seconds: Math.round(record.seconds), carId: record.carId, nodeId: record.nodeId, place: record.place, atS: Math.round(record.atS) };
        return {
            longestStillS: this.longest ? Math.round(this.longest.seconds) : 0,
            longestStill: plain(this.longest),
            /** The longest standstill (>= LOCKUP_STILL_S) with the whole queue ahead stuck too - a lockup. */
            locked: plain(this.longestLocked),
            /** The longest standstill (>= LOCKUP_STILL_S) behind a queue that still moved - saturation, not a fault. */
            starved: plain(this.longestStarved),
            cycles: this.cycleKeys.size,
            firstCycle: this.firstCycle,
            isLockup: this.longestLocked !== null || this.firstCycle !== null,
            /** Cars that stood BOX_STUCK_S or more inside a junction box: how many, per junction, and the longest. Null if none. */
            boxStuck: this.boxStuckIds.size
                ? { cars: this.boxStuckIds.size, byNode: Object.fromEntries(this.boxStuckByNode), longest: { ...plain(this.longestBoxStuck), startedDark: this.longestBoxStuck.startedDark } }
                : null,
            /** A lockup that started while a junction was dark - gridlock under all-way stops, reported but not a fault. */
            gridlock: this.longestLockedDark || this.firstCycleDark ? { locked: plain(this.longestLockedDark), firstCycle: this.firstCycleDark } : null,
        };
    }

    /** True if every car on `car`'s waits-on chain - itself to the head of its queue - has stood for LOCKUP_STILL_S. */
    _chainStuck(car, waitsOn, stillS) {
        const seen = new Set();
        for (let at = car; at && !seen.has(at) && seen.size < MAX_CHAIN; at = waitsOn.get(at)) {
            if (stillS(at) < LOCKUP_STILL_S) return false;
            seen.add(at);
        }
        return true;
    }

    /** Records every car standing BOX_STUCK_S or more inside a junction box (_boxNodeId()). */
    _findBoxStuck(cars, stillS, nowS) {
        for (const entry of cars) {
            const seconds = stillS(entry.car);
            if (seconds < BOX_STUCK_S) continue;
            const nodeId = this._boxNodeId(entry);
            if (!nodeId) continue;
            if (!this.boxStuckIds.has(entry.car.id)) {
                this.boxStuckIds.add(entry.car.id);
                this.boxStuckByNode.set(nodeId, (this.boxStuckByNode.get(nodeId) ?? 0) + 1);
            }
            if (seconds > (this.longestBoxStuck?.seconds ?? 0)) {
                this.longestBoxStuck = { seconds, ...this._describe(entry.car), nodeId, atS: nowS, startedDark: this._darkAt(nowS - seconds) };
            }
        }
    }

    /**
     * The junction whose box `entry`'s car is in, or null: a car on a turn path (a roundabout's ring included, a driveway
     * not), or a lane car whose centre is past a stop line on its road and whose rear is short of that junction's far kerb.
     */
    _boxNodeId({ car, gates }) {
        const path = car.turnPath;
        if (path) return path.driveway || path.fromDriveway ? null : path.ringNodeId ?? this._nearestNodeId(car);
        for (const gate of gates ?? []) {
            const crossedWidthM = gate.phase === 0 ? gate.node.crossRoadWidthM : gate.node.arterialRoadWidthM;
            if (car.distanceM > gate.stopLineDistanceM && car.distanceM - car.lengthM / 2 < gate.centreDistanceM + (crossedWidthM ?? 0) / 2) return gate.node.id;
        }
        return null;
    }

    /** When the jam `car` is stuck in began: the earliest standstill on its waits-on chain, itself to the head of its queue. */
    _chainStartS(car, waitsOn, stillS, nowS) {
        const seen = new Set();
        let longest = 0;
        for (let at = car; at && !seen.has(at) && seen.size < MAX_CHAIN; at = waitsOn.get(at)) {
            longest = Math.max(longest, stillS(at));
            seen.add(at);
        }
        return nowS - longest;
    }

    /** Every vehicle on the network, with what it waits on in its own lane (the car just ahead, if close). */
    _liveCars() {
        const { engine } = this;
        const result = [];
        const gatesOf = new Map();
        const addLane = (gates) => (lane) => {
            const sorted = [...lane.cars].sort((a, b) => b.distanceM - a.distanceM);
            sorted.forEach((car, i) => {
                const ahead = sorted[i - 1];
                const close = ahead && ahead.distanceM - car.distanceM - (ahead.lengthM + car.lengthM) / 2 < LANE_FOLLOW_GAP_M;
                result.push({ car, waitsOn: close ? ahead : null, gates });
                gatesOf.set(car, gates);
            });
        };
        for (const [id, state] of engine.carriagewayState) state.lanes.forEach(addLane(engine.carriagewaysById.get(id)?.gates));
        for (const [id, state] of engine.connectorState) {
            const dirs = engine.connectorDirs.get(id);
            state.fwd.lanes.forEach(addLane(dirs?.fwd?.gates));
            state.rev.lanes.forEach(addLane(dirs?.rev?.gates));
        }
        for (const car of engine.turningCars) result.push({ car, waitsOn: this._turningWaitsOn(car) });
        this._addRoundaboutExitWaits(result);
        for (const entry of result) if (!entry.waitsOn && !entry.car.turnPath) entry.waitsOn = this._frontCarWaitsOn(entry.car, gatesOf.get(entry.car));
        return result;
    }

    /**
     * A front-of-queue car held for a blocked turn waits on the car where it would land; one at the end of its road, on the
     * lane it joins. Unless its signal is red: a turn once blocked stays marked so until it goes, and with that mark a
     * right-turner waiting out the cross street's green and the cross street's left-turner waiting out its own red read
     * as waiting on each other's landing lanes - a 61 s "cycle" that was two reds (Lynnwood & Jan Shoba, batch 87a502b4).
     */
    _frontCarWaitsOn(car, gates) {
        const { engine } = this;
        const option = car.turnPlan?.blockedSinceS != null ? car.turnPlan.option : null;
        const gate = option && gates?.find((g) => g.node.id === car.turnPlan.nodeId);
        if (gate && engine._signalHolds(gate, car)) return null;
        if (option) {
            const lanes = option.carriagewayId
                ? engine.carriagewayState.get(option.carriagewayId)?.lanes
                : option.connectorId
                  ? engine.connectorState.get(option.connectorId)?.[option.dirKey]?.lanes
                  : null;
            // The nearest car from just short of the landing onwards, however far down the road: with the landing itself
            // clear for a moment, it is still that queue the turner can't get into (Herold at Lynnwood) - stopping the
            // chain at the turner would read a starved approach as stuck.
            let best = null;
            for (const lane of lanes ?? []) {
                for (const other of lane.cars) {
                    const beyond = other.distanceM - (option.entryDistanceM - LANDING_REACH_M);
                    if (beyond >= 0 && (!best || beyond < best.beyond)) best = { beyond, car: other };
                }
            }
            if (best) return best.car;
        }
        const join = car.joinSlot && engine.joinsFrom.get(car.joinSlot.key);
        if (!join || join.from.lengthM - car.distanceM > JOIN_WAIT_REACH_M) return null;
        const lane = join.to.lanes()[car.joinSlot.slot];
        let tail = null;
        for (const other of lane?.cars ?? []) if (!tail || other.distanceM < tail.distanceM) tail = other;
        return tail;
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
                const exitDistanceM = target.centreM + info.node.roundabout.mouthM + ROUNDABOUT_EXIT_RUN_M;
                const lane = target.lanes[target.laneIndex];
                // With the exit clear for a moment - a car going round took the room first - it is still that queue the
                // entry can't get into (Prospect & Hilda, its way out backed up from the Festival stop): with no link the
                // chain stopped at the entry and a starved approach read as locked.
                entry.waitsOn = blockerAt(lane, exitDistanceM, arrival.car.lengthM) ?? nearestFrom(lane, exitDistanceM - LANDING_REACH_M) ?? entry.waitsOn;
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
        const heldS = Math.min(...members.map((car) => nowS - this.stillSinceS.get(car.id)));
        const startS = Math.min(...members.map((car) => this.stillSinceS.get(car.id)));
        const slot = this._darkAt(startS) ? 'firstCycleDark' : 'firstCycle';
        if (this[slot]) return;
        const described = members.map((car) => this._describe(car));
        this[slot] = {
            carIds: described.map((d) => d.carId),
            nodeIds: [...new Set(described.map((d) => d.nodeId))],
            places: described.map((d) => d.place),
            heldS: Math.round(heldS),
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
/** The nearest car in `lane` at or past `fromM`, however far down the road. */
function nearestFrom(lane, fromM) {
    let best = null;
    for (const car of lane?.cars ?? []) if (car.distanceM >= fromM && (!best || car.distanceM < best.distanceM)) best = car;
    return best;
}

function blockerAt(lane, atM, lengthM) {
    let best = null;
    for (const car of lane?.cars ?? []) {
        const gap = Math.abs(car.distanceM - atM);
        if (gap < (car.lengthM + lengthM) / 2 + SPAWN_CLEARANCE_M && (!best || gap < best.gap)) best = { gap, car };
    }
    return best?.car ?? null;
}
