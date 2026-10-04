/**
 * engine.js - build steps 2-10.
 *
 * Pure step(dt) simulation: no rendering, no requestAnimationFrame, no DOM.
 * `simulator.js` owns the animation loop and calls `tick()` on a fixed
 * timestep; `runHeadless.js` (build step 13) calls the exact same class the
 * same way, just without a render step after each tick - that reuse is the
 * entire reason this file does not know the canvas exists.
 */
import { SeededRandom } from './rng.js';
import {
    Car,
    stepCar,
    resetCarIdCounter,
    carWorldPoint,
    lanePoint,
    buildTurnPath,
    buildPolylinePath,
    turnCorner,
    carRenderPoint,
    carRenderHeading,
    carAcceleration,
    entrySpeedBehind,
    VEHICLE_TYPES,
    TRUCK_VEHICLE_TYPES,
} from './car.js';
import { nextPoissonArrival, fluctuatingDemand, hasSufficientCall, mobilShouldChangeLane, mobilIsSafe } from './equations.js';
import { FixedTimeController } from './controllers/fixedTime.js';
import { AdaptiveController } from './controllers/adaptive.js';
import {
    AllWayStopController,
    MIN_STOP_DWELL_S,
    STOP_DWELL_JITTER_S,
    junctionClearTimeS,
    RELEASE_HESITATION_MIN_S,
    RELEASE_HESITATION_JITTER_S,
} from './controllers/allWayStop.js';
import { buildGreenWaveControllers } from './controllers/greenWave.js';
import { MinorStopController } from './controllers/minorStop.js';
import {
    RoundaboutController,
    ROUNDABOUT_SPEED_KPH,
    ROUNDABOUT_ENTRY_WINDOW_M,
    ROUNDABOUT_MAX_YIELD_S,
    ROUNDABOUT_OCCUPANT_TIMEOUT_S,
} from './controllers/roundabout.js';
import { carShapeFor } from './carShapes.js';
import { readQueueLength, detectQueuePresence, detectPresenceAtStopLine, sensorAvailable } from './sensors.js';
import { roadPointAt, TURN_LANE_TAPER_M, crossArms, leftNormal, isTurnOnlyLane } from './corridor.js';
import { buildRoutingModel } from './routing/model.js';

/** Upstream window counted as "queued" for the stats-footer chips. */
const QUEUE_WINDOW_M = 150;
/** Matches the yellow/all-red constants every controller (fixedTime/adaptive/greenWave) times its transition on - only used here to caption the hover tooltip's countdown. */
const YELLOW_S = 3;
const ALL_RED_S = 1;
/** Wait-time/throughput rolling window - also makes "cleared in the window" equal cleared-per-minute. */
const ROLLING_WINDOW_S = 60;
export const CHART_SAMPLE_INTERVAL_S = 0.5;
/**
 * How a vehicle's wait is counted - stamped on every batch run so results under different
 * accounting are never compared as like for like. 'trip-carried-v1': a turn no longer resets it
 * (carryTripStats()), the whole trip's wait counted where the vehicle leaves the network.
 * 'trip-carried-scope-by-road-v2': the total scope still counts each vehicle's whole trip, but a
 * scope (an arterial, the arterial connectors, the side streets) counts each vehicle that used it
 * once, with only the wait it built up on that scope's roads (_attributeWaits()).
 */
export const WAIT_ACCOUNTING = 'trip-carried-scope-by-road-v2';
/** Minimum clearance ahead of a freshly spawned/diverted car so it doesn't start already emergency-braking. */
const SPAWN_CLEARANCE_M = 4;
/** How close to the stop line a car commits to its planned movement (and a car still in the wrong lane gives up on it). */
const CROSS_DECISION_WINDOW_M = 5;
/** A car joining a road picks its lane for a junction this close along it (m) - see _joinTargetSlot(). */
const JOIN_PLAN_REACH_M = 150;
/** How far before the end of a joined road a car starts following traffic (and the signal) on the road it joins. */
const JOIN_LOOKAHEAD_M = 150;
/** A joined road whose first stop line sits within this of its start is approached from the road before it - that road's cars queue for its signal. */
const JOIN_FEED_REACH_M = 5;
/** A minor-road driver at a stop street waits until no arterial vehicle would reach the junction within this many seconds. */
const MINOR_STOP_CRITICAL_GAP_S = 4;
/** After a minor-road car is let go, the next waits this share of the all-way stop's junction-clear time. */
const MINOR_STOP_LOCK_SHARE = 0.6;
/** Backstop: a car let into an all-way stop's box stops counting as in it after this long, even if it was never seen leaving. */
const ALL_WAY_STOP_OCCUPANT_MAX_S = 20;
/** A car merging from a turn road (or a slip road) gives way to one on the road it joins that would reach the merge point within this many seconds. */
const MERGE_GIVE_WAY_S = 2.5;
/** How far before the end of its road a merging car starts watching for a gap - it stops at the end if there isn't one. */
const MERGE_WATCH_M = 40;
/** How far before a peel-off point a car decides whether it takes it, and works its way into the kerb lane if so. */
const DIVERGE_DECISION_M = 200;
/** How far before the end of a road that joins a narrower one a car in an ending lane starts merging out of it. */
const MERGE_OUT_M = 160;
/** A turning car whose way onto the cross street is blocked holds at the stop line - for at most this long, then it carries straight on so a jammed side street can never lock the arterial. */
const MAX_TURN_WAIT_S = 30;
/**
 * Speed a car drives its turn at (km/h, scaled by the vehicle's desiredSpeedFactor
 * so trucks take it slower). A left turn in left-hand traffic is the tight kerbside
 * corner; a right turn sweeps the wider radius across the junction.
 */
const TURN_SPEED_KPH = { left: 18, right: 22 };
/**
 * A cross-street driver turning right (across the oncoming half of a two-way
 * street, left-hand traffic) waits until no oncoming vehicle would reach the
 * junction within this many seconds - a standard critical gap for an
 * opposed turn at a signalised junction.
 */
const ONCOMING_CRITICAL_GAP_S = 4.5;
/**
 * Right-turners who pull into the junction on a green ball to wait for their gap, then clear as the oncoming side
 * stops - legal in SA, and a large part of a real right turn's capacity. At most this many per approach at once.
 */
const MAX_WAITING_IN_BOX = 2;
/** Where along its turn path such a car waits - short of the oncoming lanes. */
const BOX_WAIT_SHARE = 0.4;
/** Backstop: a car that has waited in the box this long goes anyway, so a stuck signal can't lock it there. */
const BOX_WAIT_MAX_S = 60;
/** Comfortable braking a driver plans on when slowing for a turn (m/s^2) - the approach speed limit follows v^2 = vTurn^2 + 2*b*d. */
const TURN_APPROACH_DECEL_MPS2 = 1.5;
/** Shortest straight run into and out of a turn's corner (m) - keeps even a kerbside left turn a real curve, not a pivot. */
const MIN_TURN_LEG_M = 4;
/** Sprite variety (build step 11) - must match renderer.js PALETTE.carPalette.length in both themes. */
const CAR_PALETTE_SIZE = 4;
/** Widest randomised driver reaction lag (seconds) before pulling away from a stop - see car.js:stepCar()'s startup gate. */
const MAX_STARTUP_DELAY_S = 0.8;
/** Per-car desired-speed jitter, as a fraction either side of the road's target speed - real drivers don't all pick the exact same cruising speed. */
const DESIRED_SPEED_JITTER = 0.08;

/**
 * Random-events mode (setRandomEvents()) - a just-for-fun overlay, never on in
 * batch runs. Its dice come from their own `eventRng`, so with it off not one
 * extra draw is taken from the main RNG and every run stays bit-identical.
 */
const EVENT_SEED_SALT = 0x9e3779b9;

/**
 * Destination routing (routing/model.js) - each origin road gets its own
 * arrival stream and its own trip stream (destination, route variant), seeded
 * from the run seed and the road, so every controller sees the same arrivals
 * and the same trips for a seed however differently the traffic then plays out.
 * In random mode neither exists and the main RNG is drawn exactly as before.
 */
const ARRIVAL_SEED_SALT = 0x85ebca6b;
const TRIP_SEED_SALT = 0xc2b2ae35;

/** _routeArc()'s answer for a car already on its destination block. */
const ON_DESTINATION_BLOCK = { kind: 'onBlock' };

/** Destination-routing counters for one run (or since resetStats()). */
function newRoutingStats() {
    return {
        /** Trips that ended: out of the map, or pulled off into a block. */
        trips: 0,
        tripTimeSumS: 0,
        toExit: 0,
        pulledOff: 0,
        /** Trips that ended somewhere other than the destination they set out for. */
        diverted: 0,
        /** A routed car that didn't make its planned movement (wrong lane at the stop line, blocked turn, no room at a peel-off). */
        missedTurns: 0,
        /** missedTurns by cause - wrongLane, blockedTurn (MAX_TURN_WAIT_S ran out), peelNoRoom - and by node (`<road>@<node>`). */
        missedBy: { wrongLane: 0, blockedTurn: 0, peelNoRoom: 0 },
        missedAt: {},
        /** A routed car that could no longer reach its destination from where it was, and was sent to the nearest exit instead. */
        rerouted: 0,
        pulledOffByBlock: {},
    };
}

/** FNV-1a: a stable 32-bit number for a road key, to seed its streams. */
function hashKey(key) {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i += 1) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
/** Share of plain cars that spawn as the BMW / the Ranger instead (car.js's VEHICLE_TYPES). */
const BMW_SHARE = 0.02;
const RANGER_SHARE = 0.05;
/** Random tie-break (m/s^2) added to each of the BMW's lane-change options, so it weaves across every lane rather than ping-ponging between the first two. */
const BMW_WEAVE_JITTER_MPS2 = 0.5;
/** Mean and minimum distance (m) a taxi drives between pickups. */
const TAXI_PICKUP_MEAN_SPACING_M = 350;
const TAXI_PICKUP_MIN_SPACING_M = 60;
/** Taxi dwell at a pickup: at least this long, plus up to the jitter (s). */
const TAXI_PICKUP_MIN_DWELL_S = 6;
const TAXI_PICKUP_DWELL_JITTER_S = 12;
/** Deceleration a taxi plans its stop on - it picks a spot this far ahead, it doesn't stop dead. */
const TAXI_PICKUP_DECEL_MPS2 = 2;
/** Clear of the junctions either side of a pickup spot (m) - taxis don't stop on a stop line or in a junction's exit. */
const TAXI_PICKUP_JUNCTION_CLEARANCE_M = 30;

/** MOBIL (equations.js) is suppressed within this many metres of a car's own spawn point, so it doesn't immediately dart across lanes before it has settled into traffic. */
const LANE_CHANGE_MIN_DISTANCE_M = 15;
/** ...and within this many metres of the next stop line, so a car isn't still weaving lanes for speed right at the junction. Mandatory (turn-lane) changes are exempt. */
const LANE_CHANGE_STOPLINE_EXCLUSION_M = 20;
/** Minimum physical bumper-to-bumper clearance a lane change may leave, on top of MOBIL's own acceleration-based safety criterion - stops a change from ever visually overlapping two cars. */
const MIN_LANE_CHANGE_GAP_M = 2;
/** Seconds a car commits to a lane after changing before it's allowed to evaluate another one - stops unrealistic tick-by-tick weaving. */
const LANE_CHANGE_COOLDOWN_S = 4;
/**
 * A car that has just come out of a turn holds its lane this long before any lane change -
 * so where two lanes turn together (a double turn lane) neither cuts across the other the
 * moment they straighten up; the change it needs comes a few car lengths on, with a gap.
 */
const TURN_EXIT_SETTLE_S = 3;
/** Shorter settle time between MANDATORY changes, so a car crossing several lanes towards its turn lane still gets there within a block. */
const MANDATORY_LANE_CHANGE_COOLDOWN_S = 1.5;
/**
 * Merging into a turn lane: a car that must change lanes but has a vehicle
 * alongside it in the target lane eases off (comfortable deceleration, down to
 * a crawl) so the gap opens behind that vehicle; if instead the
 * vehicle just behind in the target lane is too close, that driver eases off to
 * let it in. Without this, two cars at near-identical cruising speeds can run
 * side by side for a whole block and the turn is never reached.
 */
const MERGE_DROP_BACK_DECEL_MPS2 = -1.0;
const MERGE_DROP_BACK_MIN_SPEED_MPS = 3;
/**
 * A car still in a lane its planned movement isn't allowed from, crawling in
 * a queue this close to the stop line, gives up on the change and makes the
 * movement its lane is marked for instead - a driver trapped in a turn-only
 * lane turns. Waiting for a gap here would hold up the whole lane behind it.
 */
const MANDATORY_GIVE_UP_M = 40;

function jitteredDesiredSpeed(v0, rng) {
    return v0 * (1 - DESIRED_SPEED_JITTER + 2 * DESIRED_SPEED_JITTER * rng.next());
}

/**
 * A turn hands the vehicle over as a new Car on the road it turns onto. Its
 * trip stats travel with it, so the wait it built up before the turn still
 * counts when it clears - stats only, nothing here feeds the driving model.
 */
function carryTripStats(from, to) {
    to.totalWaitS = from.totalWaitS;
    to.everStopped = from.everStopped;
    to.stoppedForSignal = from.stoppedForSignal;
    to.trip = from.trip;
    to.waitByKey = from.waitByKey;
    to.stoppedKeys = from.stoppedKeys;
    to.waitSeenS = from.waitSeenS;
    // Wait in the junction box belongs to the road it is turning off.
    to.turnFromKey = from.road.statsKey;
    return to;
}

function nearestAhead(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a.distanceM <= b.distanceM ? a : b;
}

/** The car furthest back in a lane (nearest its entry), or null - `lane.cars` isn't always sorted mid-tick. */
function lastCarIn(lane) {
    let last = null;
    for (const car of lane?.cars ?? []) if (!last || car.distanceM < last.distanceM) last = car;
    return last;
}

/** The nearest car at or past `pointM` in a lane, and the nearest one behind it. */
function aroundPoint(lane, pointM) {
    let leader = null;
    let follower = null;
    for (const car of lane?.cars ?? []) {
        if (car.distanceM >= pointM) {
            if (!leader || car.distanceM < leader.distanceM) leader = car;
        } else if (!follower || car.distanceM > follower.distanceM) {
            follower = car;
        }
    }
    return { leader, follower };
}

/** Enough room for `car` to merge at `pointM` ahead of `follower` - its length plus MERGE_GIVE_WAY_S of the follower's travel. */
function mergeGapBehind(follower, car, pointM) {
    return pointM - follower.distanceM - (follower.lengthM + car.lengthM) / 2 >= follower.speedMps * MERGE_GIVE_WAY_S + 1;
}

function negateHeading(h) {
    return { x: -h.x, y: -h.y };
}

/** `car`'s nearest leader/follower within `carsSortedDesc` (front-first, as every lane array is kept sorted) - excludes `car` itself so this is safe to call whether or not `car` is currently a member. */
/**
 * The busiest lane's share of an approach's flow, once each movement is
 * spread over only the lanes `laneUse` lets it use - as evenly as drivers
 * picking the shorter queue would (each movement in turn water-fills its own
 * lanes over the others' load, repeated until it settles). `movementShares`
 * is `{ straight, left, right }` of the approach's flow; `slots` limits the
 * lanes counted (an approach fed by a narrower road). A movement no lane
 * allows spreads over them all - cars stuck like that make whatever turn
 * their lane allows at the stop line.
 */
const LANE_BALANCE_PASSES = 30;
function criticalLaneShare(laneUse, slots, movementShares) {
    const load = new Map(slots.map((slot) => [slot, 0]));
    const groups = Object.entries(movementShares)
        .filter(([, share]) => share > 0)
        .map(([movement, share]) => {
            const lanes = lanesAllowing(laneUse, movement).filter((slot) => load.has(slot));
            return { share, lanes: lanes.length ? lanes : slots, split: new Map() };
        });
    for (let pass = 0; pass < LANE_BALANCE_PASSES; pass++) {
        for (const group of groups) {
            for (const [slot, part] of group.split) load.set(slot, load.get(slot) - part);
            // Fill this movement's lanes up to one common level over what the others already put there.
            const base = group.lanes.map((slot) => load.get(slot)).sort((a, b) => a - b);
            let level = base[0] + group.share;
            for (let k = 1; k <= base.length; k++) {
                const candidate = (base.slice(0, k).reduce((a, b) => a + b, 0) + group.share) / k;
                if (k === base.length || candidate <= base[k]) {
                    level = candidate;
                    break;
                }
            }
            group.split = new Map(group.lanes.map((slot) => [slot, Math.max(0, level - load.get(slot))]));
            for (const [slot, part] of group.split) load.set(slot, load.get(slot) + part);
        }
    }
    return Math.max(...load.values());
}

/** Lane indices whose lane use (one entry per lane, kerb first) allows `movement`. */
function lanesAllowing(laneUse, movement) {
    const lanes = [];
    laneUse.forEach((moves, i) => {
        if (moves.includes(movement)) lanes.push(i);
    });
    return lanes;
}

/**
 * Which lane a turn comes out in: turning lanes pair up with target lanes in
 * order - the kerb-most left-turn lane into the kerb lane, the next into the
 * lane beside it, and so on (right turns likewise from the median side). A
 * double turn lane therefore fills two lanes of the road it turns into. More
 * turning lanes than target lanes share the last one. Never into the target
 * road's own turn lanes - the result is one of its through lanes' slots.
 */
function turnTargetLane(laneUse, fromLane, movement, targetLayout) {
    const targetLaneCount = targetLayout.mainLanes;
    const turning = lanesAllowing(laneUse, movement);
    const index = Math.max(0, turning.indexOf(fromLane));
    if (movement === 'left') return targetLayout.kerbSlots + Math.min(index, targetLaneCount - 1);
    return targetLayout.kerbSlots + Math.max(0, targetLaneCount - 1 - (turning.length - 1 - index));
}

/*
 * Turn lanes (corridor.js's `turnLanes`). A road's cars live in lane SLOTS,
 * kerb first: one slot outside the kerb lane if any approach along the road
 * has a kerb-side turn lane, then the road's own through lanes, then one slot
 * past the median-side lane if any approach has a median-side turn lane. With
 * no turn lanes the slots are exactly the lanes, so nothing changes. A turn
 * lane slot only exists over its last `lengthM` before a stop line - cars
 * enter it there and turn out of it at the junction; nobody spawns in one.
 */

/** Lane use for a slot that has no turn lane at this approach - no movement allowed from it. */
const CLOSED_SLOT = Object.freeze([]);

/** Slot layout of one road (an arterial, or one direction of a connector) from the approaches along it. */
function buildLaneLayout(approaches, mainLanes) {
    const kerbSlots = approaches.some((a) => a.turnLanes?.left) ? 1 : 0;
    const medianSlots = approaches.some((a) => a.turnLanes?.right) ? 1 : 0;
    return { kerbSlots, mainLanes, slots: kerbSlots + mainLanes + medianSlots, turnLanes: [] };
}

/**
 * One approach's lane use by slot - the same per-lane arrays as
 * `approach.laneUse`/its turn lanes (the lane-arrow editor changes them in
 * place, so edits apply live), CLOSED_SLOT where this approach has no turn lane.
 * Also records where along the road each of its turn lanes exists.
 */
function attachApproachToLayout(laneLayout, approach, stopLineDistanceM) {
    const kerb = approach.turnLanes?.left;
    const median = approach.turnLanes?.right;
    const medianSlot = laneLayout.kerbSlots + laneLayout.mainLanes;
    // Open from the start of its taper, so a car can move over as the road widens.
    // One that also goes straight stays open across the junction box, so its straight-on cars drive through in it.
    const endFor = (turnLane) => stopLineDistanceM + (turnLane.laneUse.includes('straight') ? 2 * approach.setbackM : 0);
    if (kerb) laneLayout.turnLanes.push({ slot: 0, startM: stopLineDistanceM - kerb.lengthM - TURN_LANE_TAPER_M, endM: endFor(kerb) });
    if (median) laneLayout.turnLanes.push({ slot: medianSlot, startM: stopLineDistanceM - median.lengthM - TURN_LANE_TAPER_M, endM: endFor(median) });
    return [
        ...(laneLayout.kerbSlots ? [kerb?.laneUse ?? CLOSED_SLOT] : []),
        ...approach.laneUse,
        ...(medianSlot < laneLayout.slots ? [median?.laneUse ?? CLOSED_SLOT] : []),
    ];
}

function isThroughSlot(laneLayout, slot) {
    return slot >= laneLayout.kerbSlots && slot < laneLayout.kerbSlots + laneLayout.mainLanes;
}

/** A through lane always exists; a turn-lane slot only where one of its turn lanes is, measured at a car's front bumper. */
function slotOpenAt(laneLayout, slot, distanceM) {
    if (slot < 0 || slot >= laneLayout.slots) return false;
    if (isThroughSlot(laneLayout, slot)) return true;
    return laneLayout.turnLanes.some((t) => t.slot === slot && distanceM >= t.startM && distanceM <= t.endM);
}

/** The through lane beside a turn-lane slot - where a car waits to get into it, and where it goes back to. */
function throughSlotBeside(laneLayout, slot) {
    return slot < laneLayout.kerbSlots ? laneLayout.kerbSlots : laneLayout.kerbSlots + laneLayout.mainLanes - 1;
}

/**
 * Lanes a car planning `movement` should head for right now. `allowed` is
 * every slot whose lane use allows it; `target` is where the car should be:
 * with no turn lane involved that's `allowed` itself. Where the movement can
 * be made from a turn lane, the car moves into it once it's alongside, and
 * until then may wait in the through lane beside it.
 */
function laneTargets(laneLayout, slotLaneUse, movement, distanceM) {
    const allowed = lanesAllowing(slotLaneUse, movement);
    const turnSlots = allowed.filter((slot) => !isThroughSlot(laneLayout, slot));
    if (!turnSlots.length) return { allowed, target: allowed };
    const open = turnSlots.filter((slot) => slotOpenAt(laneLayout, slot, distanceM));
    const through = allowed.filter((slot) => isThroughSlot(laneLayout, slot));
    // A through lane allows it too (straight on, with a turn lane that also goes straight): the turn lane is just one more lane for it.
    if (through.length && movement === 'straight') return { allowed, target: [...through, ...open] };
    if (open.length) return { allowed, target: open };
    return { allowed, target: [...new Set([...through, ...turnSlots.map((slot) => throughSlotBeside(laneLayout, slot))])] };
}

/** A lane's state for one run: through lanes draw their own arrivals, turn-lane slots never spawn. */
/**
 * laneTargets() for a car's plan - narrowed, for a routed car going straight
 * on, to the lanes that also suit its turn at the junction after (plan.preferLanes),
 * so it moves over a block early instead of fighting across a queue at the last moment.
 */
function planLaneTargets(laneLayout, slotLaneUse, plan, distanceM) {
    const lanes = laneTargets(laneLayout, slotLaneUse, plan.movement, distanceM);
    if (!plan.preferLanes?.length) return lanes;
    const preferred = lanes.target.filter((slot) => plan.preferLanes.includes(slot));
    return preferred.length ? { ...lanes, target: preferred } : lanes;
}

function makeLaneStates(laneLayout, sampleArrival) {
    return Array.from({ length: laneLayout.slots }, (_, slot) =>
        isThroughSlot(laneLayout, slot) ? { cars: [], timerS: 0, nextArrivalS: sampleArrival() } : { cars: [], isTurnLane: true }
    );
}

/** IDM desired-speed cap for a car braking comfortably to reach its turn at turning speed. */
function turnApproachSpeedLimit(car, movement, toStopM) {
    const vTurn = turnSpeedMps(car, movement);
    return Math.sqrt(vTurn * vTurn + 2 * TURN_APPROACH_DECEL_MPS2 * Math.max(0, toStopM));
}

/** How far round the ring (radians) a car takes to move from its entry lane onto the circulating line, and back out to its exit lane. */
const ROUNDABOUT_MERGE_RAD = 0.45;
/** A car coming round the ring this close to where another would join it, round the ring, takes priority (m) - about 3 s at roundabout speed. */
const ROUNDABOUT_GAP_M = 20;
/** Within this behind a car joining the ring (m), a circulating one is alongside it - still in the way. */
const ROUNDABOUT_ALONGSIDE_M = 5;
/** How far round the ring a car looks for one ahead to follow (m). */
const RING_FOLLOW_M = 25;
/** Spacing of the points along a car's way round a roundabout (m). */
const ROUNDABOUT_PATH_STEP_M = 1.5;
/** How far past a roundabout's circle a car rejoins its exit road's lane (m). */
const ROUNDABOUT_EXIT_RUN_M = 3;

/** Slack (radians) when sorting a roundabout's arms by angle, so a slightly skewed arm still counts as the one it is. */
const ROUNDABOUT_ARM_TOLERANCE_RAD = 0.35;

/** IDM desired-speed cap for a car braking comfortably to reach a roundabout's yield line at ROUNDABOUT_SPEED_KPH - Infinity at any other junction. */
function roundaboutApproachSpeedLimit(car, gate) {
    if (gate.info.controllerType !== 'roundabout') return Infinity;
    const vEntry = (ROUNDABOUT_SPEED_KPH / 3.6) * VEHICLE_TYPES[car.vehicleType].desiredSpeedFactor;
    return Math.sqrt(vEntry * vEntry + 2 * TURN_APPROACH_DECEL_MPS2 * Math.max(0, gate.stopLineDistanceM - car.distanceM));
}

/** Left or right, from the arterial heading into the connector direction - y points south, so a positive cross product is a turn to the right. */
function turnMovement(arterialHeading, exitHeading) {
    const cross = arterialHeading.x * exitHeading.y - arterialHeading.y * exitHeading.x;
    return cross > 0 ? 'right' : 'left';
}

/** Physical bumper clearance to both neighbours in a target lane - stops a change from ever visually overlapping two cars. */
function hasClearanceAhead(car, leader) {
    return !leader || leader.distanceM - leader.lengthM - car.distanceM >= MIN_LANE_CHANGE_GAP_M;
}

function hasClearanceBehind(car, follower) {
    return !follower || car.distanceM - car.lengthM - follower.distanceM >= MIN_LANE_CHANGE_GAP_M;
}

function hasLaneChangeClearance(car, leader, follower) {
    return hasClearanceAhead(car, leader) && hasClearanceBehind(car, follower);
}

/**
 * IDM cap for a car dropping back to merge: brake gently while moving. At a
 * crawl it carries on with its own lane instead of holding still - stopping
 * dead with open road ahead would block every car behind it in that lane.
 */
function mergeDropBackCap(car) {
    return car.speedMps > MERGE_DROP_BACK_MIN_SPEED_MPS ? MERGE_DROP_BACK_DECEL_MPS2 : Infinity;
}

/** A junction run by traffic lights: signal control, with something arriving on the arterial side to stop the cross street for. */
function isSignalled(info) {
    return info.node.control === 'signal' && info.arterialGates.length > 0;
}

/** Do all-way stop approaches `a` and `b` face each other across the box? */
function allWayStopOpposing(a, b) {
    const ha = a.approach?.heading;
    const hb = b.approach?.heading;
    return Boolean(ha && hb) && ha.x * hb.x + ha.y * hb.y < -0.5;
}

/** Would front cars `a` and `b`, from opposite approaches at `nodeId`, cross paths - a right turn across the other side's straight or left (left-hand traffic: two right turns pass each other). */
function allWayStopPathsCross(nodeId, a, b) {
    const moves = (cars) => cars.map((c) => (c.turnPlan?.nodeId === nodeId ? c.turnPlan.movement : 'straight'));
    const ma = moves(a);
    const mb = moves(b);
    return (ma.includes('right') && mb.some((m) => m !== 'right')) || (mb.includes('right') && ma.some((m) => m !== 'right'));
}

/** An all-way stop, a stop street or a roundabout: no lights - each car waits for its own release (car.releasedNodeIds) instead. */
function entersByRelease(controllerType) {
    return controllerType === 'allWayStop' || controllerType === 'minorStop' || controllerType === 'roundabout';
}

/** `entersByRelease()` for a car on road `phase` (0 the arterial, 1 the cross street): at a stop street the arterial isn't held. */
function entersByReleaseAt(controllerType, phase) {
    return entersByRelease(controllerType) && !(controllerType === 'minorStop' && phase === 0);
}

/** Turning speed for `movement` for this vehicle (m/s). */
function turnSpeedMps(car, movement) {
    return (TURN_SPEED_KPH[movement] / 3.6) * VEHICLE_TYPES[car.vehicleType].desiredSpeedFactor;
}

function neighborsInLane(carsSortedDesc, car) {
    let leader = null;
    let follower = null;
    for (const c of carsSortedDesc) {
        if (c === car) continue;
        if (c.distanceM > car.distanceM) leader = c;
        else if (follower === null) {
            follower = c;
            break;
        }
    }
    return { leader, follower };
}

/**
 * A junction's controller, as seen from one of the road directions through it
 * (see SimulationEngine's gates) - so arterial code can ask a gate for its
 * signal exactly as it used to ask the junction.
 */
class Gate {
    constructor(fields) {
        Object.assign(this, fields);
    }

    get controller() {
        return this.info.controller;
    }

    get controllerType() {
        return this.info.controllerType;
    }
}

export class SimulationEngine {
    constructor(layout) {
        this.layout = layout;
        this.nodesInfo = new Map(); // nodeId -> junction info: controller + the gates through it
        this.nodeInfosByArterial = new Map(); // arterialId -> junction info[], in arterial order
        /**
         * Every direction of travel of every arterial - one for a one-way
         * arterial, two for a two-way one ('fwd' along its own direction,
         * then 'rev') - in arterial order. Each is a road of its own with its
         * own lanes; the two directions of a two-way arterial share its
         * junctions (and so their signals).
         */
        this.carriageways = [];
        this.carriagewaysById = new Map();
        this.carriagewaysByArterial = new Map(); // arterialId -> carriageway[]
        this.gatesByApproachId = new Map(); // approach id -> the gate it is the stop line of
        this.connectorsById = new Map(layout.connectors.map((c) => [c.id, c]));
        this.connectorDirs = new Map(); // connectorId -> { fwd, rev }
        this.arterialState = new Map(); // arterialId -> per-run state (mode, demand, stats)
        this.carriagewayState = new Map(); // carriageway id -> per-run lanes
        this.connectorState = new Map(); // connectorId -> per-run state
        this.rng = new SeededRandom(1);
        this.simTimeS = 0;
        this.powerState = 'normal';
        this.power = { manual: false, scheduled: false, offMinutes: 2, periodMinutes: 8 };
        this.sensorMode = 'inductive_loop';
        this.batteryBackedSensors = true;
        /** Fraction (0-1) of newly-spawned vehicles that are trucks, split evenly across TRUCK_VEHICLE_TYPES - see setTruckRatio()/_rollVehicleType(). */
        this.truckRatio = 0;
        /** Fraction (0-1) of newly-spawned vehicles that are buses - see setBusRatio()/_rollVehicleType(). */
        this.busRatio = 0;
        /** Random-events mode - see EVENT_SEED_SALT above and setRandomEvents(). */
        this.randomEvents = false;
        this.eventRng = new SeededRandom(1);
        this.accounting = { totalSpawned: 0, totalClearedNetwork: 0 };

        for (const arterial of layout.arterials) {
            const infos = arterial.intersections.map((node) => {
                const info = {
                    node,
                    arterial,
                    controller: null,
                    controllerType: null,
                    // Per-phase "how long has this approach had an uninterrupted call" - only
                    // consumed by _isOtherCallSufficient() (debounce for narrow sensors, maxCallWaitS for wide ones).
                    callPersistenceS: [0, 0],
                    /** Per-phase radar count samples over the last `callDebounceS` - see _isOtherCallSufficient(). */
                    radarSamples: [[], []],
                    /** The arterial direction(s) through this junction - one gate each (signal phase 0). */
                    arterialGates: [],
                    /** The cross-street direction(s) through it (phase 1). */
                    crossGates: [],
                    /** `arterialGates` plus any arterial direction that only leaves here - see _buildCarriageway(). */
                    arterialExits: [],
                };
                this.nodesInfo.set(node.id, info);
                return info;
            });
            this.nodeInfosByArterial.set(arterial.id, infos);

            const carriageways = (arterial.oneWay ? ['fwd'] : ['fwd', 'rev']).map((dirKey) => this._buildCarriageway(arterial, dirKey));
            this.carriagewaysByArterial.set(arterial.id, carriageways);
            for (const carriageway of carriageways) {
                this.carriageways.push(carriageway);
                this.carriagewaysById.set(carriageway.id, carriageway);
            }
        }

        // Connector direction geometry (build step 9) - purely derived from the
        // static layout, so this only ever needs computing once, not per reset().
        // 'fwd' travels the connector's own heading, through its linked nodes in
        // the order listed; 'rev' the opposite way (two-way only). A car turning
        // onto the connector enters that direction partway through, at the
        // node's own distance along it - see _divertCarToConnector().
        for (const connector of layout.connectors) {
            const perSide = connector.twoWay ? Math.max(1, Math.floor(connector.lanes / 2)) : connector.lanes;
            const dirs = {
                fwd: {
                    road: {
                        heading: connector.heading,
                        startPoint: connector.startPoint,
                        roadWidthM: connector.roadWidthM,
                        lanes: perSide,
                        laneWidthM: connector.laneWidthM,
                        // Set only for a curved connector (a ramp) - see corridor.js's
                        // roadPointAt(), the seam that makes car.js/this file's own
                        // distanceM/speedMps-only physics agnostic to curve vs. straight.
                        curve: connector.curve,
                    },
                },
                rev: {
                    road: {
                        heading: negateHeading(connector.heading),
                        startPoint: connector.endPoint,
                        roadWidthM: connector.roadWidthM,
                        lanes: connector.twoWay ? perSide : 0,
                        laneWidthM: connector.laneWidthM,
                        curve: connector.curveReversed,
                    },
                },
            };
            // Distance 0 in each direction's frame is the connector's own stub tip
            // (connector.startPoint/endPoint - see corridor.js), not a node, so
            // natively-spawned side-street cars enter off-map and drive up to the
            // first junction, the same way arterial cars enter at arterial.startPoint.
            // A car travelling its full length passes every linked junction's
            // signal in sequence - each one a real gate.
            for (const dirKey of ['fwd', 'rev']) {
                const dir = dirs[dirKey];
                const order = connector.nodeIds.map((nodeId, i) => ({ nodeId, offsetM: connector.nodeOffsetsM[i] }));
                if (dirKey === 'rev') order.reverse();
                dir.gates = order.map(({ nodeId, offsetM }) => {
                    const centreM = dirKey === 'fwd' ? connector.stubStartM + offsetM : connector.stubEndM + connector.spanM - offsetM;
                    return this._buildConnectorGate(connector, dir, dirKey, this.nodesInfo.get(nodeId).node, centreM);
                });
                dir.laneLayout = buildLaneLayout(dir.gates.map((gate) => gate.approach).filter(Boolean), dir.road.lanes);
                for (const gate of dir.gates) {
                    gate.slotLaneUse = gate.approach ? attachApproachToLayout(dir.laneLayout, gate.approach, gate.stopLineDistanceM) : null;
                }
                dir.road.kerbSlots = dir.laneLayout.kerbSlots;
                // A street that starts at a T has no road before its first junction to spawn on - its traffic only turns in.
                dir.noSpawn = Boolean(dir.gates.length && !dir.gates[0].approach);
            }
            this.connectorDirs.set(connector.id, dirs);
        }

        // The turns each gate offers, fixed by geometry: from an arterial
        // direction into each connector direction through the node, and back.
        for (const carriageway of this.carriageways) {
            for (const gate of carriageway.gates) gate.turnOptions = this._arterialTurnOptions(gate);
        }
        for (const connector of layout.connectors) {
            for (const dir of Object.values(this.connectorDirs.get(connector.id))) {
                for (const gate of dir.gates) gate.turnOptions = gate.phase === 0 ? this._arterialTurnOptions(gate) : this._connectorTurnOptions(gate, dir);
            }
        }

        // The protected turns each junction's signal gives their own arrow (corridor.js's parseTurnPhases()).
        for (const info of this.nodesInfo.values()) {
            /** Per road (0 arterial, 1 cross), the turn stage in front of its through green: `{ gates, weight }` - or null. */
            info.turnStages = [null, null];
            for (const { approach, movement, weight } of info.node.turnPhases ?? []) {
                const gate = this.gatesByApproachId.get(approach.id);
                gate.turnPhase = { movement, full: false };
                const stage = (info.turnStages[gate.phase] ??= { gates: [], weight: 0 });
                stage.gates.push(gate);
                stage.weight = Math.max(stage.weight, weight);
            }
            // A lone lead (the approach opposite has no arrow of its own) runs its whole approach with the arrow - green ball
            // and arrow together, the opposing side held so the turn is protected. Where both opposing approaches have
            // arrows, only the turn lanes go (each side's through would cross the other's turn).
            for (const stage of info.turnStages) {
                for (const gate of stage?.gates ?? []) {
                    const h = gate.approach.heading;
                    gate.turnPhase.full = !stage.gates.some((other) => other !== gate && other.approach.heading.x * h.x + other.approach.heading.y * h.y < -0.5);
                }
            }
        }

        // Road-to-road joins (corridor.js's parseJoins()): a car reaching the end of
        // `from` drives onto the start of `to` instead of leaving the map.
        this.joinsFrom = new Map();
        this.joinsInto = new Map();
        /** A joined road's first gate, when it sits right at the road's start - the road before it is that approach's queue. */
        this.feedersByGate = new Map();
        /** Partway merges into each road (turn roads joining it), and partway peel-offs from it - by road key. */
        this.mergesInto = new Map();
        this.divergesFrom = new Map();
        for (const raw of layout.joins ?? []) {
            const join = { from: this._joinRoad(raw.from), to: this._joinRoad(raw.to), fromAtM: raw.fromAtM, toAtM: raw.toAtM, share: raw.share, slip: raw.slip };
            // A road started by a join spawns none of its own traffic (a partway merge into it doesn't change that).
            if (join.toAtM == null) join.to.dir.fed = true;
            if (join.fromAtM != null) {
                if (join.slip) {
                    // A slip road takes the left-turn lane's cars ahead of the stop line, so that gate's signal doesn't hold them.
                    join.gate = this._slipGateOf(join);
                    if (join.gate) join.gate.slipJoin = join;
                }
                if (!this.divergesFrom.has(join.from.key)) this.divergesFrom.set(join.from.key, []);
                this.divergesFrom.get(join.from.key).push(join);
                this.joinsInto.set(join.to.key, join);
                continue;
            }
            this.joinsFrom.set(join.from.key, join);
            if (join.toAtM != null) {
                if (!this.mergesInto.has(join.to.key)) this.mergesInto.set(join.to.key, []);
                this.mergesInto.get(join.to.key).push(join);
                continue;
            }
            this.joinsInto.set(join.to.key, join);
            const first = join.to.gates[0];
            // Not a gate with no approach on a road along the arterial's line that only leaves its junction - an arterial direction or an arm road (its traffic arrives through the junction).
            if (first && first.stopLineDistanceM < JOIN_FEED_REACH_M && (first.approach || (!first.node.crossSplit && !first.carriageway && !first.node.arterialArmRoads?.includes(first.connector)))) this.feedersByGate.set(first, join);
        }
        this._stampStatsKeys();
    }

    /**
     * Which stats bucket each road's wait and clears count in - the per-arterial stats, the
     * arterial connectors', or the side streets'. Stamped on the road geometry object every car
     * on it shares, so _attributeWaits() reads it straight off `car.road`.
     */
    _stampStatsKeys() {
        for (const carriageway of this.carriageways) carriageway.road.statsKey = carriageway.arterial.scope === 'side' ? 'side' : carriageway.arterial.id;
        for (const connector of this.layout.connectors) {
            for (const dir of Object.values(this.connectorDirs.get(connector.id))) dir.road.statsKey = connector.scope === 'arterial' ? 'arterialConnectors' : 'side';
        }
    }

    _statsFor(key) {
        if (key === 'side') return this.sideStreetStats;
        if (key === 'arterialConnectors') return this.arterialConnectorStats;
        return this.arterialState.get(key).stats;
    }

    /** The gate a slip road's join (`slip: true`) leaves ahead of: the next stop line on its road past where it peels off. */
    _slipGateOf(join) {
        return join.from.gates.find((gate) => gate.stopLineDistanceM > join.fromAtM && gate.approach) ?? null;
    }

    /** One end of a join as the engine sees it: the road direction, its geometry and gates, and its live lanes. */
    _joinRoad(ref) {
        if (ref.kind === 'arterial') {
            const carriageway = this.carriagewaysById.get(ref.key);
            return {
                key: ref.key, kind: 'arterial', dir: carriageway, road: carriageway.road, lengthM: carriageway.lengthM,
                gates: carriageway.gates, laneLayout: carriageway.laneLayout, lanes: () => this.carriagewayState.get(carriageway.id).lanes,
            };
        }
        const connector = this.connectorsById.get(ref.id);
        const dir = this.connectorDirs.get(ref.id)[ref.dirKey];
        return {
            key: ref.key, kind: 'connector', connector, dir, road: dir.road, lengthM: connector.routeLengthM,
            gates: dir.gates, laneLayout: dir.laneLayout, lanes: () => this.connectorState.get(ref.id)[ref.dirKey].lanes,
        };
    }

    /**
     * One direction of `arterial` as a road of its own: its lanes, and a gate at
     * each junction in the order its cars reach them. 'fwd' starts at the
     * arterial's own start point; 'rev' (a two-way arterial's other half) at its
     * end point, running back through the same junctions.
     */
    _buildCarriageway(arterial, dirKey) {
        const isFwd = dirKey === 'fwd';
        const lastNode = arterial.intersections[arterial.intersections.length - 1];
        const road = {
            heading: isFwd ? arterial.heading : negateHeading(arterial.heading),
            startPoint: isFwd ? arterial.startPoint : arterial.endPoint,
            roadWidthM: arterial.roadWidthM,
            lanes: arterial.perSideLanes,
            laneWidthM: arterial.laneWidthM,
            // Set only for a curved (one-way) arterial - see corridor.js's roadPointAt().
            // curveOffsetM lines up this road's distanceM=0 (the approach
            // lead-in's spawn point) with the curve's own t=0 (the first node).
            curve: arterial.curve,
            curveOffsetM: arterial.approachLengthM,
        };
        const carriageway = {
            id: isFwd ? arterial.id : `${arterial.id}:rev`,
            arterial,
            dirKey,
            road,
            lengthM: arterial.centrelineLengthM,
        };

        const nodes = isFwd ? arterial.intersections : [...arterial.intersections].reverse();
        carriageway.gates = nodes.map((node) => {
            const info = this.nodesInfo.get(node.id);
            // None where this direction only leaves the junction - the arterial starts there (corridor.js's arterialArms()).
            const approach = node.approaches.find((a) => a.kind === 'arterial' && !a.connectorId && a.dirKey === dirKey) ?? null;
            const centreDistanceM = isFwd ? arterial.approachLengthM + node.sAlongM : arterial.exitLengthM + lastNode.sAlongM - node.sAlongM;
            const setbackM = approach?.setbackM ?? node.crossRoadWidthM / 2;
            const arms = node.arterialArms[isFwd ? 0 : 1];
            const gate = new Gate({ node, info, carriageway, approach, phase: 0, centreDistanceM, stopLineDistanceM: centreDistanceM - setbackM, turnOptions: [], hasDownstream: arms.hasDownstream });
            /** Every arterial direction through the junction, arriving or only leaving - what a cross-street car can turn into. */
            info.arterialExits.push(gate);
            if (approach) {
                info.arterialGates.push(gate);
                this.gatesByApproachId.set(approach.id, gate);
            }
            return gate;
        });

        carriageway.laneLayout = buildLaneLayout(carriageway.gates.map((gate) => gate.approach).filter(Boolean), road.lanes);
        for (const gate of carriageway.gates) {
            /** Lane use by lane slot (turn lanes included) - what every lookup by `car.lane` reads. */
            gate.slotLaneUse = gate.approach ? attachApproachToLayout(carriageway.laneLayout, gate.approach, gate.stopLineDistanceM) : null;
        }
        road.kerbSlots = carriageway.laneLayout.kerbSlots;
        /** Starts at a junction it only leaves (no road before it): its traffic only turns in there. */
        carriageway.noSpawn = Boolean(carriageway.gates.length && !carriageway.gates[0].approach);
        return carriageway;
    }

    /**
     * One junction on a connector direction: its stop line in that direction's
     * frame - the node's centre pulled back by half the arterial's width, the
     * same setback corridor.js gives every 'cross' approach, so a car stops
     * before the junction box instead of halfway across it - and the cross
     * approach there.
     */
    _buildConnectorGate(connector, dir, dirKey, node, centreDistanceM) {
        const info = this.nodesInfo.get(node.id);
        const approach = node.approaches.find((a) => a.connectorId === connector.id && a.dirKey === dirKey) ?? null;
        /** Signal phase - 1 for a cross street, 0 for a road arriving along the arterial's line (corridor.js's arterialArmsOf()). */
        const phase = approach?.kind === 'arterial' ? 0 : 1;
        const isArm = node.arterialArmRoads?.includes(connector) ?? false;
        const gate = new Gate({ node, info, connector, dir, dirKey, approach, phase, centreDistanceM, stopLineDistanceM: centreDistanceM - (approach?.setbackM ?? node.arterialRoadWidthM / 2), turnOptions: [] });
        // At a split junction a road's direction that only leaves (or only arrives past) it has no approach there - not one of its signal's.
        if (phase === 0) info.arterialGates.push(gate);
        else if (!isArm && dir.road.lanes > 0 && (approach || !node.crossSplit)) info.crossGates.push(gate);
        if (approach) this.gatesByApproachId.set(approach.id, gate);
        return gate;
    }

    /** Movements a lane on `approach` could physically make - straight, plus whichever turns the junction's geometry offers. The lane-arrow editor only offers markings made of these. */
    movementsAt(approach) {
        const gate = this.gatesByApproachId.get(approach.id);
        const turns = (gate?.turnOptions ?? []).map((o) => o.movement);
        // At a T the street stops here - nothing goes straight on.
        return approach.noStraight ? turns : ['straight', ...turns];
    }

    /**
     * Each connector direction an arterial car at `gate` can turn into, with
     * where it enters that direction's frame - at the node's own distance
     * along it, so into the rest of the street beyond (a one-way connector
     * only ever takes its one legal direction). Nearest entry first, so a
     * street's own first junction lists its own direction first.
     */
    _arterialTurnOptions(gate) {
        if (!gate.approach) return [];
        if (gate.node.crossSplit) return this._splitArterialTurnOptions(gate);
        const connector = gate.node.connectorId ? this.connectorsById.get(gate.node.connectorId) : null;
        if (!connector) return [];
        const dirs = this.connectorDirs.get(connector.id);
        const arms = crossArms(connector, gate.node);
        return ['fwd', 'rev']
            // Not into the missing arm of a T.
            .filter((dirKey, i) => dirs[dirKey].road.lanes > 0 && arms[i].hasDownstream)
            .map((dirKey) => ({ dirKey, entryDistanceM: dirs[dirKey].gates.find((g) => g.node === gate.node).centreDistanceM }))
            .sort((a, b) => a.entryDistanceM - b.entryDistanceM)
            .map((c) => {
                // The street's own heading at this node - a curved street's differs from node to node.
                const heading = c.dirKey === 'fwd' ? gate.node.crossAxis : negateHeading(gate.node.crossAxis);
                return { ...c, connectorId: connector.id, movement: turnMovement(gate.approach.heading, heading) };
            });
    }

    /**
     * _arterialTurnOptions() at a junction where the cross street is two roads
     * (corridor.js's splitCrossStreet()): turning towards the end side lands on
     * the end road's fwd, towards the start side on the start road's rev - each
     * at the junction's own distance along that road.
     */
    _splitArterialTurnOptions(gate) {
        const { start, end } = gate.node.crossSplit;
        return [
            { connector: end.connector, dirKey: 'fwd', heading: gate.node.crossAxis },
            { connector: start.connector, dirKey: 'rev', heading: negateHeading(gate.node.crossAxis) },
        ]
            .filter(({ connector, dirKey }) => this.connectorDirs.get(connector.id)[dirKey].road.lanes > 0)
            .map(({ connector, dirKey, heading }) => ({
                dirKey,
                entryDistanceM: this.connectorDirs.get(connector.id)[dirKey].gates.find((g) => g.node === gate.node).centreDistanceM,
                connectorId: connector.id,
                movement: turnMovement(gate.approach.heading, heading),
            }));
    }

    /**
     * The turns a cross-street car at `gate` can make onto the junction's
     * arterial - one onto a one-way arterial (left or right depending on which
     * way it runs), onto either direction of a two-way one - each joining that
     * direction at the node, in its own frame.
     */
    _connectorTurnOptions(gate, dir) {
        if (!gate.approach || !dir.road.lanes) return [];
        const ontoArterial = gate.info.arterialExits
            .filter((arterialGate) => arterialGate.hasDownstream)
            .map((arterialGate) => ({
                arterialId: gate.info.arterial.id,
                carriagewayId: arterialGate.carriageway.id,
                movement: turnMovement(gate.approach.heading, arterialGate.carriageway.dirKey === 'fwd' ? gate.node.arterialHeading : negateHeading(gate.node.arterialHeading)),
                entryDistanceM: arterialGate.centreDistanceM,
            }));
        // Onto the outbound half of a road along the arterial's line that starts or stops here (Burnett east of Jan Shoba, eastbound).
        const ontoArms = (gate.node.arterialArmRoads ?? []).flatMap((road) =>
            ['fwd', 'rev']
                .map((dirKey) => ({ dirKey, dir: this.connectorDirs.get(road.id)[dirKey] }))
                // Not where the arterial itself carries on into it (Park east of Jan Shoba) - turning onto the arterial already gets there.
                .filter(({ dirKey, dir }) => dir.road.lanes > 0 && !(this.layout.joins ?? []).some((j) => j.toAtM == null && j.to.key === `${road.id}:${dirKey}` && j.from.kind === 'arterial' && j.from.id === gate.info.arterial.id))
                .map(({ dirKey, dir }) => ({ dirKey, armGate: dir.gates.find((g) => g.node === gate.node) }))
                // Leaving here, with road beyond (in each direction's own frame).
                .filter(({ armGate }) => !armGate.approach && armGate.centreDistanceM < road.routeLengthM - 1)
                .map(({ dirKey, armGate }) => ({
                    connectorId: road.id,
                    dirKey,
                    movement: turnMovement(gate.approach.heading, roadPointAt(armGate.dir.road, armGate.centreDistanceM).heading),
                    entryDistanceM: armGate.centreDistanceM,
                }))
        );
        return [...ontoArterial, ...ontoArms];
    }

    /** Full restart: new seed, fresh cars, fresh stats. Also what the seed-determinism check (build step 12) needs. */
    reset({ seed, arterialModes, demand, sensorMode, batteryBackedSensors, power, truckRatio = 0, busRatio = 0, randomEvents = false, routingMode = null }) {
        this.rng.reseed(seed);
        this.eventRng.reseed(seed ^ EVENT_SEED_SALT);
        this._resetRouting(seed, routingMode);
        this.randomEvents = randomEvents;
        resetCarIdCounter();
        this.simTimeS = 0;
        this.sensorMode = sensorMode;
        this.batteryBackedSensors = batteryBackedSensors;
        this.truckRatio = truckRatio;
        this.busRatio = busRatio;
        this.power = {
            manual: !!power.loadShedding,
            scheduled: !!power.scheduledOutages,
            offMinutes: power.offMinutes,
            periodMinutes: power.periodMinutes,
        };
        this.powerState = this._computePowerState();
        this.accounting = { totalSpawned: 0, totalClearedNetwork: 0 };
        /** Cars currently driving their turn through a junction - on neither the arterial nor the cross street yet (see _stepTurningCars()). */
        this.turningCars = [];
        // Combined side-street (all connectors) wait/throughput stats - one bucket, not
        // one per connector, since nothing downstream needs per-connector granularity.
        this.sideStreetStats = { clearedTotal: 0, clearedWithoutStopTotal: 0, waitSumTotal: 0, recentClears: [] };
        // Connectors marked `scope: "arterial"` (a major road modelled as a cross street) - one
        // combined bucket, counted with the arterials instead of the side streets.
        this.arterialConnectorStats = { clearedTotal: 0, clearedWithoutStopTotal: 0, waitSumTotal: 0, recentClears: [] };
        // Every vehicle once, with its whole trip's wait - the total scope. Not the sum of the scopes: a trip can use several.
        this.totalStats = { clearedTotal: 0, clearedWithoutStopTotal: 0, waitSumTotal: 0, recentClears: [] };
        // Every vehicle that used any arterial (or arterial connector) once, with the wait it built up on them - the arterial scope.
        this.arterialScopeStats = { clearedTotal: 0, clearedWithoutStopTotal: 0, waitSumTotal: 0, recentClears: [] };
        // Every completed vehicle's total wait, network-wide, in clear order - the raw
        // material for a full-run median/p95/max wait (see waitDistributionTotal()).
        this.allWaitTimesTotal = [];

        this.arterialState.clear();
        this.carriagewayState.clear();
        for (const arterial of this.layout.arterials) {
            const spawnRatePerLanePerMin = demand[arterial.id] ?? arterial.demand.spawnRatePerLanePerMin;
            for (const carriageway of this.carriagewaysByArterial.get(arterial.id)) {
                this.carriagewayState.set(carriageway.id, {
                    laneLayout: carriageway.laneLayout,
                    lanes: makeLaneStates(carriageway.laneLayout, () => this._sampleArrival(this._liveSpawnRate(arterial.demand, spawnRatePerLanePerMin), this._arrivalRng(carriageway.id))),
                });
            }
            this.arterialState.set(arterial.id, {
                mode: arterialModes[arterial.id] ?? arterial.mode,
                spawnRatePerLanePerMin,
                saturationFlowPerLanePerHour: arterial.demand.saturationFlowPerLanePerHour,
                stats: {
                    clearedTotal: 0,
                    clearedWithoutStopTotal: 0,
                    // Cumulative, never pruned (unlike `recentClears`) - this is what lets
                    // buildSummary() in runHeadless.js compute a true full-run (or segment)
                    // average wait instead of a 60s-rolling-window snapshot.
                    waitSumTotal: 0,
                    recentClears: [],
                    clearedByNode: Object.fromEntries(arterial.intersections.map((node) => [node.id, 0])),
                },
                chartSamples: [],
                chartAccumS: 0,
            });
        }

        this.connectorState.clear();
        for (const connector of this.layout.connectors) {
            const dirs = this.connectorDirs.get(connector.id);
            const rate = this._liveSpawnRate(connector.demand, connector.demand.spawnRatePerLanePerMin);
            const makeDirState = (dir, dirKey) => ({ laneLayout: dir.laneLayout, lanes: makeLaneStates(dir.laneLayout, () => this._sampleArrival(rate, this._arrivalRng(`${connector.id}:${dirKey}`))) });
            this.connectorState.set(connector.id, {
                fwd: makeDirState(dirs.fwd, 'fwd'),
                rev: makeDirState(dirs.rev, 'rev'),
            });
        }

        this._rebuildAllControllers();
    }

    setArterialMode(arterialId, mode) {
        const state = this.arterialState.get(arterialId);
        if (!state) return;
        state.mode = mode;
        this._rebuildControllersForArterial(arterialId);
    }

    /** `id` is either an arterial id or a connector id - both carry a spawnRatePerLanePerMin. */
    setDemand(id, ratePerLanePerMin) {
        const arterialState = this.arterialState.get(id);
        if (arterialState) {
            arterialState.spawnRatePerLanePerMin = ratePerLanePerMin;
            this._recomputeAllTiming();
            return;
        }

        const connector = this.connectorsById.get(id);
        if (!connector) return;
        connector.demand.spawnRatePerLanePerMin = ratePerLanePerMin;
        this._recomputeAllTiming();
    }

    /**
     * Same idea as setDemand(), but for an id whose corridor config already
     * gave it a fluctuation range (corridor.js's buildDemand()) - moving
     * either handle is an explicit "re-survey the count" action, same as
     * dragging the flat slider, so the design flow (now the new midpoint)
     * and the Webster plan built from it both update; the live spawn rate
     * then keeps wandering within the new bounds same as before.
     */
    setDemandRange(id, minPerLanePerMin, maxPerLanePerMin) {
        const midpoint = (minPerLanePerMin + maxPerLanePerMin) / 2;

        const arterial = this.layout.arterials.find((a) => a.id === id);
        const arterialState = this.arterialState.get(id);
        if (arterial && arterialState) {
            arterial.demand.fluctuation = { ...arterial.demand.fluctuation, minPerLanePerMin, maxPerLanePerMin };
            arterial.demand.spawnRatePerLanePerMin = midpoint;
            arterialState.spawnRatePerLanePerMin = midpoint;
            this._recomputeAllTiming();
            return;
        }

        const connector = this.connectorsById.get(id);
        if (!connector) return;
        connector.demand.fluctuation = { ...connector.demand.fluctuation, minPerLanePerMin, maxPerLanePerMin };
        connector.demand.spawnRatePerLanePerMin = midpoint;
        this._recomputeAllTiming();
    }

    /** The rate that would actually be used to draw this id's next car arrival right now - read-only, never touches rng, safe to poll every frame for a UI readout. */
    liveSpawnRate(id) {
        const arterial = this.layout.arterials.find((a) => a.id === id);
        const arterialState = this.arterialState.get(id);
        if (arterial && arterialState) return this._liveSpawnRate(arterial.demand, arterialState.spawnRatePerLanePerMin);

        const connector = this.connectorsById.get(id);
        if (!connector) return null;
        return this._liveSpawnRate(connector.demand, connector.demand.spawnRatePerLanePerMin);
    }

    /**
     * Any demand change moves the planned flows at every junction - turning
     * traffic carries an arterial's demand onto the cross streets and from
     * there onto the other arterial - so every plan is re-derived.
     */
    _recomputeAllTiming() {
        for (const arterial of this.layout.arterials) this._recomputeTimingForArterial(arterial.id);
    }

    setSensorMode(mode) {
        this.sensorMode = mode;
    }

    setBatteryBackedSensors(value) {
        this.batteryBackedSensors = !!value;
    }

    /** Takes effect for vehicles spawned from now on - doesn't retroactively change cars already on the road. */
    setTruckRatio(ratio) {
        this.truckRatio = Math.min(1, Math.max(0, ratio));
    }

    /** Same as setTruckRatio(), for buses. */
    setBusRatio(ratio) {
        this.busRatio = Math.min(1, Math.max(0, ratio));
    }

    /**
     * Random events: a rare purple BMW that weaves at 20 over, Ranger double cabs
     * tailgating in the fastest lane, and the taxis (already on the road as a
     * body style) stopping in the kerb lane to pick people up. The BMW and Ranger
     * only come from new spawns, so switching this off lets them drain out; the
     * taxis stop pulling over straight away.
     */
    setRandomEvents(enabled) {
        this.randomEvents = !!enabled;
        if (this.randomEvents) return;
        for (const state of this.carriagewayState.values()) {
            for (const lane of state.lanes) {
                for (const car of lane.cars) car.pickup = null;
            }
        }
    }

    /**
     * Which vehicle type a newly-spawned car should be, per the truck- and bus-mix
     * sliders - trucks split evenly across TRUCK_VEHICLE_TYPES. Buses share the
     * truck roll's one draw (the band just above truckRatio) rather than drawing
     * their own, so with 0% buses the main RNG sequence - and so every batch run
     * and replay - is exactly what it was before buses existed.
     */
    _rollVehicleType() {
        const roll = this.rng.next();
        if (roll < this.truckRatio) return TRUCK_VEHICLE_TYPES[Math.floor(this.rng.next() * TRUCK_VEHICLE_TYPES.length)];
        if (roll < this.truckRatio + this.busRatio) return 'bus';
        return this.randomEvents ? this._rollEventCarType() : 'car';
    }

    /** Random events: a plain car's chance of being the BMW or the Ranger instead - from `eventRng`, never the main RNG. */
    _rollEventCarType() {
        const roll = this.eventRng.next();
        if (roll < BMW_SHARE) return 'bmw';
        if (roll < BMW_SHARE + RANGER_SHARE) return 'ranger';
        return 'car';
    }

    /** A new vehicle's cruising speed on a road with target speed `v0` (m/s) - the per-driver jitter, scaled by type, plus any random-events extra. */
    _desiredSpeedFor(vehicleType, v0) {
        const spec = VEHICLE_TYPES[vehicleType];
        return jitteredDesiredSpeed(v0 * spec.desiredSpeedFactor, this.rng) + (spec.extraSpeedKph ?? 0) / 3.6;
    }

    /** A minibus taxi that stops for passengers - one of the plain cars drawn with the taxi body style, only while random events are on. */
    _isPickupTaxi(car) {
        return this.randomEvents && car.vehicleType === 'car' && carShapeFor(car.id) === 'taxi';
    }

    /**
     * Zeroes every CUMULATIVE stats accumulator (clears, wait sums, the full-run wait
     * distribution) WITHOUT touching cars on the road, signal/queue state, RNG, or power state
     * - the standard traffic-sim warm-up technique: run the corridor from empty past its own
     * ramp-up transient first, then call this once to start measuring from an
     * already-equilibrated network instead of from a cold start. See runHeadless.js's
     * `warmupTicks`, which calls this right as the measured phase begins.
     *
     * Deliberately does NOT touch `recentClears` (the 60s rolling window `avgWaitRolling`/
     * `throughputPerMin` read from): that window is self-pruning and already reflects genuinely
     * equilibrated traffic the instant warm-up ends, so clearing it would just fabricate a fake
     * "corridor restarting from empty" dip in the rolling rate for the next 60s, on top of the
     * real one warm-up already spent ticks eliminating.
     *
     * A car already in transit at the moment this is called keeps whatever wait/stopped state
     * it accumulated during warm-up and carries it into its eventual (measured) clear - a minor,
     * standard edge effect at the warm-up boundary that only affects the handful of vehicles
     * mid-trip at that instant, not an ongoing bias.
     */
    resetStats() {
        for (const state of this.arterialState.values()) {
            state.stats.clearedTotal = 0;
            state.stats.clearedWithoutStopTotal = 0;
            state.stats.waitSumTotal = 0;
            for (const nodeId of Object.keys(state.stats.clearedByNode)) {
                state.stats.clearedByNode[nodeId] = 0;
            }
        }
        for (const bucket of [this.sideStreetStats, this.arterialConnectorStats, this.totalStats, this.arterialScopeStats]) {
            bucket.clearedTotal = 0;
            bucket.clearedWithoutStopTotal = 0;
            bucket.waitSumTotal = 0;
        }
        this.allWaitTimesTotal = [];
        this.routingStats = newRoutingStats();
    }

    setManualLoadShedding(active) {
        this.power.manual = !!active;
        this._syncPowerState();
    }

    setPowerSchedule({ scheduledOutages, offMinutes, periodMinutes }) {
        this.power.scheduled = !!scheduledOutages;
        if (offMinutes != null) this.power.offMinutes = offMinutes;
        if (periodMinutes != null) this.power.periodMinutes = periodMinutes;
        this._syncPowerState();
    }

    /** Advance the whole simulation by one fixed timestep. */
    tick(dt) {
        this.simTimeS += dt;
        /** Stamped on each car as it's stepped, so one handed onto a road stepped later this tick isn't moved twice. */
        this.tickNo = (this.tickNo ?? 0) + 1;
        this._syncPowerState();

        for (const info of this.nodesInfo.values()) {
            if (info.controllerType === 'adaptive') {
                const { controller } = info;
                const detected = controller.inTurn ? this._turnLaneDetected(info, controller.phase) : this._vehicleDetectedAtStopLine(info, controller.phase);
                const otherCallSufficient = this._isOtherCallSufficient(info, controller.phase, dt);
                controller.tick(dt, detected, otherCallSufficient, [this._turnLaneCalled(info, 0), this._turnLaneCalled(info, 1)]);
            } else if (info.controllerType === 'greenWave') {
                info.controller.tick(dt, this.simTimeS);
            } else {
                info.controller.tick(dt);
            }
        }

        this._updateAllWayStopReleases();
        this._updateRoundaboutReleases();

        for (const carriageway of this.carriageways) {
            this._spawnForCarriageway(carriageway, dt);
        }

        for (const carriageway of this.carriageways) {
            this._stepCarriagewayCars(carriageway, dt);
        }

        for (const connector of this.layout.connectors) {
            this._spawnForConnector(connector, dt);
        }

        for (const connector of this.layout.connectors) {
            this._stepConnectorCars(connector, dt);
        }

        // After the cross streets, so a car that finishes its turn this tick isn't stepped twice.
        this._stepTurningCars(dt);
        this._attributeWaits();

        for (const state of this.arterialState.values()) {
            this._pruneRolling(state.stats);
        }
        this._pruneRolling(this.sideStreetStats);
        this._pruneRolling(this.arterialConnectorStats);
        this._pruneRolling(this.totalStats);
        this._pruneRolling(this.arterialScopeStats);

        this._sampleChart(dt);
    }

    /** Everything the render loop / stats footer needs for one frame (or one row of headless output). */
    snapshot() {
        const cars = [];
        for (const carriageway of this.carriageways) {
            for (const lane of this.carriagewayState.get(carriageway.id).lanes) {
                for (const car of lane.cars) {
                    cars.push({
                        id: car.id,
                        point: carRenderPoint(car),
                        stopped: car.stoppedNow,
                        heading: carRenderHeading(car),
                        colourIndex: car.colourIndex,
                        vehicleType: car.vehicleType,
                        lengthM: car.lengthM,
                        widthM: car.widthM,
                    });
                }
            }
        }
        for (const connector of this.layout.connectors) {
            const state = this.connectorState.get(connector.id);
            for (const dirKey of ['fwd', 'rev']) {
                for (const lane of state[dirKey].lanes) {
                    for (const car of lane.cars) {
                        cars.push({
                            id: car.id,
                            point: carRenderPoint(car),
                            stopped: car.stoppedNow,
                            heading: carRenderHeading(car),
                            colourIndex: car.colourIndex,
                            vehicleType: car.vehicleType,
                            lengthM: car.lengthM,
                            widthM: car.widthM,
                        });
                    }
                }
            }
        }
        for (const car of this.turningCars) {
            cars.push({
                id: car.id,
                point: carRenderPoint(car),
                stopped: car.stoppedNow,
                heading: carRenderHeading(car),
                colourIndex: car.colourIndex,
                vehicleType: car.vehicleType,
                lengthM: car.lengthM,
                widthM: car.widthM,
            });
        }

        const signals = new Map();
        for (const [nodeId, info] of this.nodesInfo) {
            const dark = this.powerState === 'load_shedding';
            const isYellow = !dark && info.controllerType !== 'none' && info.controller.phaseState === 'yellow';
            const inTurn = Boolean(info.controller.inTurn);
            signals.set(nodeId, {
                dark,
                arterialGreen: !dark && info.controller.isArterialGreen(),
                arterialYellow: isYellow && !inTurn && info.controller.phase === 0,
                crossGreen: !dark && info.controller.isCrossGreen(),
                crossYellow: isYellow && !inTurn && info.controller.phase === 1,
                /** Per approach with a protected turn, the state of its arrow: `{ [approachId]: { movement, green, yellow, through } }`. */
                turns: Object.fromEntries(
                    info.turnStages.flatMap((stage, phase) =>
                        (stage?.gates ?? []).map((gate) => [
                            gate.approach.id,
                            {
                                movement: gate.turnPhase.movement,
                                green: !dark && Boolean(info.controller.turnGreen?.(phase)),
                                yellow: !dark && Boolean(info.controller.turnYellow?.(phase)),
                                /** A lone lead approach's own through green, on alongside its arrow - see _turnArrowFor(). */
                                through: !dark && gate.turnPhase.full && Boolean(info.controller.inTurn) && info.controller.phase === phase,
                            },
                        ])
                    )
                ),
                // A highway merge point (an arterial with mode:"none") has no
                // signal at all, not just an unlit one - the renderer skips
                // drawing its stop lines/housings entirely instead of showing
                // a dark head, which would read as a broken light.
                freeFlow: info.controllerType === 'none',
            });
        }

        const stats = {};
        for (const arterial of this.layout.arterials) {
            const state = this.arterialState.get(arterial.id);
            const liveCars = this.carriagewaysByArterial.get(arterial.id).flatMap((carriageway) => this._carriagewayCars(carriageway));
            const stoppedCars = liveCars.filter((c) => c.stoppedNow);
            const recent = state.stats.recentClears;

            const queues = {};
            for (const info of this.nodeInfosByArterial.get(arterial.id) ?? []) {
                queues[info.node.id] = this._arterialQueueAt(info);
            }

            stats[arterial.id] = {
                onRoad: liveCars.length,
                avgWaitNow: stoppedCars.length
                    ? stoppedCars.reduce((s, c) => s + c.totalWaitS, 0) / stoppedCars.length
                    : 0,
                avgWaitRolling: recent.length ? recent.reduce((s, c) => s + c.waitS, 0) / recent.length : 0,
                throughputPerMin: recent.length,
                clearedTotal: state.stats.clearedTotal,
                waitSumTotal: state.stats.waitSumTotal,
                clearedWithoutStopTotal: state.stats.clearedWithoutStopTotal,
                clearedWithoutStopPct: state.stats.clearedTotal
                    ? (state.stats.clearedWithoutStopTotal / state.stats.clearedTotal) * 100
                    : null,
                queues,
                clearedByNode: state.stats.clearedByNode,
                chartSamples: state.chartSamples,
            };
        }

        const bucketStats = (bucket) => ({
            avgWaitRolling: bucket.recentClears.length
                ? bucket.recentClears.reduce((s, c) => s + c.waitS, 0) / bucket.recentClears.length
                : 0,
            throughputPerMin: bucket.recentClears.length,
            clearedTotal: bucket.clearedTotal,
            waitSumTotal: bucket.waitSumTotal,
            clearedWithoutStopTotal: bucket.clearedWithoutStopTotal,
            clearedWithoutStopPct: bucket.clearedTotal ? (bucket.clearedWithoutStopTotal / bucket.clearedTotal) * 100 : null,
        });
        const sideStreet = bucketStats(this.sideStreetStats);
        const total = bucketStats(this.totalStats);
        const arterialScope = bucketStats(this.arterialScopeStats);
        // Null on a corridor with no `scope: "arterial"` connector, so it adds nothing to the arterial scope there.
        const arterialConnectors = this.layout.connectors.some((c) => c.scope === 'arterial') ? bucketStats(this.arterialConnectorStats) : null;

        return {
            simTimeS: this.simTimeS,
            powerState: this.powerState,
            randomEvents: this.randomEvents,
            cars,
            signals,
            stats,
            sideStreet,
            arterialConnectors,
            total,
            arterialScope,
            sensorAvailable: sensorAvailable(this.sensorMode, this.powerState, this.batteryBackedSensors),
        };
    }

    /**
     * Verification pass (build step 14): cars spawned minus cars cleared should
     * equal cars currently on the road, network-wide (arterials + connectors).
     * Diverting a car onto a connector is a transfer, not a spawn/clear, so it
     * never touches these counters - see _divertCarToConnector().
     */
    carAccounting() {
        const onRoadArterials = [...this.carriagewayState.values()].reduce(
            (n, s) => n + s.lanes.reduce((m, l) => m + l.cars.length, 0),
            0
        );
        const onRoadConnectors = [...this.connectorState.values()].reduce(
            (n, s) => n + s.fwd.lanes.reduce((m, l) => m + l.cars.length, 0) + s.rev.lanes.reduce((m, l) => m + l.cars.length, 0),
            0
        );
        const onRoadNetwork = onRoadArterials + onRoadConnectors + this.turningCars.length;
        return {
            totalSpawned: this.accounting.totalSpawned,
            totalClearedNetwork: this.accounting.totalClearedNetwork,
            onRoadNetwork,
            balanced: this.accounting.totalSpawned === this.accounting.totalClearedNetwork + onRoadNetwork,
        };
    }

    /* ------------------------------------------------------------- internals */

    /**
     * Webster input (fixedTime.js / greenWave.js) for the arterial phase at
     * `node`: the flow per lane actually arriving there, not just what enters
     * at the arterial's start - see _plannedApproachFlows(). Same
     * `{ spawnRatePerLanePerMin, saturationFlowPerLanePerHour }` shape the
     * controllers' flowRatio() reads, with the arriving flow as the rate.
     */
    _arterialDemandAt(node) {
        const info = this.nodesInfo.get(node.id);
        const s = this.arterialState.get(info.arterial.id);
        const flow = this._plannedApproachFlows().get(node.id);
        return { spawnRatePerLanePerMin: flow.arterialPerLanePerMin, saturationFlowPerLanePerHour: s.saturationFlowPerLanePerHour };
    }

    /** Webster input for the cross phase at `node`: its critical (busiest per lane) cross-street approach - see _plannedApproachFlows(). */
    _crossDemandFor(node) {
        if (!node.connectorId) return null; // a bare cross-street stub carries no configured demand
        const connector = this.connectorsById.get(node.connectorId);
        if (!connector) return null;
        const flow = this._plannedApproachFlows().get(node.id);
        return { spawnRatePerLanePerMin: flow.crossPerLanePerMin, saturationFlowPerLanePerHour: connector.demand.saturationFlowPerLanePerHour };
    }

    /**
     * The design flow (veh/min, per lane) arriving at each junction's arterial
     * and cross-street approaches - the q in Webster's y = q/s. Built from the
     * design spawn rates (the fluctuation midpoint, as before) plus the turning
     * the engine actually does: an arterial car turns off at a connector node
     * with `crossChance`, split evenly over the turns its lane use allows
     * (_rollTurnPlan()); a cross-street car turns onto the arterial with
     * `turnChance` (_rollConnectorTurnPlan()). So an arterial loses its
     * turners downstream and gains the side streets' turn-ins, and a
     * cross-street approach carries its own arrivals plus whatever turned in
     * off the arterial it just crossed. The arterials feed each other through
     * the connectors, so this is iterated to its fixed point (every turn share
     * is < 1, so it settles within a few passes).
     *
     * A phase's y is its critical lane group's (Webster 1958): each phase
     * serves both directions of its road at once, so it takes the busier.
     *
     * Every direction of travel (each arterial direction, each connector
     * direction) is a chain of gates: its own arrivals enter at the start, each
     * gate loses its turners, and turn-ins join wherever they enter - so a
     * turn-in only reaches the gates beyond the junction it turned at.
     */
    _plannedApproachFlows() {
        if (this.routingActive) return this._flowsFromArrivals(new Map([...this.routingModel.movementFlowByGate].map(([gate, flow]) => [gate, flow.total])));
        const arrivals = new Map(); // gate -> veh/min arriving on that approach (all its lanes)
        const arterialRoads = this.carriageways.map((carriageway) => ({
            key: carriageway.id,
            gates: carriageway.gates,
            spawnPerMin: carriageway.noSpawn ? 0 : carriageway.road.lanes * this.arterialState.get(carriageway.arterial.id).spawnRatePerLanePerMin,
            // A connector node sends `crossChance` of the arterial's cars off, split over the turns its lane use allows - all of them where the arterial stops.
            turnShare: (gate) => (gate.approach?.noStraight ? 1 : gate.node.connectorId ? this.connectorsById.get(gate.node.connectorId).crossChance : 0),
            lose: (flow, share) => flow - flow * share,
            turnInKey: (option) => `${option.connectorId}:${option.dirKey}`,
        }));
        const connectorRoads = this.layout.connectors.flatMap((connector) =>
            ['fwd', 'rev']
                .filter((dirKey) => this.connectorDirs.get(connector.id)[dirKey].road.lanes)
                .map((dirKey) => ({
                    key: `${connector.id}:${dirKey}`,
                    gates: this.connectorDirs.get(connector.id)[dirKey].gates,
                    spawnPerMin: this.connectorDirs.get(connector.id)[dirKey].noSpawn ? 0 : this.connectorDirs.get(connector.id)[dirKey].road.lanes * connector.demand.spawnRatePerLanePerMin,
                    // Everything turns at a T. Arriving along the arterial's line, it turns off like the arterial's traffic does.
                    turnShare: (gate) =>
                        gate.approach?.noStraight ? 1 : gate.phase === 0 ? (gate.node.connectorId ? this.connectorsById.get(gate.node.connectorId).crossChance : 0) : connector.turnChance,
                    lose: (flow, share) => flow * (1 - share),
                    turnInKey: (option) => option.carriagewayId ?? `${option.connectorId}:${option.dirKey}`,
                }))
        );
        // The arterials feed off the connectors' previous pass, the connectors off
        // this pass's arterials - the same order the fixed point was always found in.
        // A road fed by a join starts with whatever leaves the road before it (last pass's figure).
        const roadsByKey = new Map([...arterialRoads, ...connectorRoads].map((road) => [road.key, road]));
        for (const road of roadsByKey.values()) road.exitOf = (key) => roadsByKey.get(key)?.exitPerMin;
        const feed = (road) => {
            const join = this.joinsInto.get(road.key);
            if (!join) return;
            const from = roadsByKey.get(join.from.key);
            road.spawnPerMin = (join.fromAtM != null ? from?.divergedPerMin?.[road.key] : from?.exitPerMin) ?? 0;
        };
        for (let pass = 0; pass < 20; pass++) {
            const arterialTurnIns = this._plannedTurnIns(connectorRoads, arrivals);
            for (const road of arterialRoads) {
                feed(road);
                this._plannedRoadFlows(road, arterialTurnIns.get(road.key) ?? [], arrivals);
            }
            const connectorTurnIns = this._plannedTurnIns(arterialRoads, arrivals);
            for (const road of connectorRoads) {
                feed(road);
                // Turn-ins from the arterials, plus any off a road arriving along an arterial's line onto this cross street.
                this._plannedRoadFlows(road, [...(connectorTurnIns.get(road.key) ?? []), ...(arterialTurnIns.get(road.key) ?? [])], arrivals);
            }
        }

        return this._flowsFromArrivals(arrivals);
    }

    /**
     * Each junction's Webster inputs from the flow arriving at each of its approaches (veh/min, all lanes):
     * the critical lane's flow per phase, and the busiest protected-turn lane's per road.
     * Destination routing supplies `arrivals` from its routed flows instead of the turn chances.
     */
    _flowsFromArrivals(arrivals) {
        const flows = new Map();
        for (const info of this.nodesInfo.values()) {
            flows.set(info.node.id, {
                arterialPerLanePerMin: info.arterialGates.reduce((max, gate) => Math.max(max, (arrivals.get(gate) ?? 0) * this._criticalLaneShareAt(gate, gate.carriageway?.road ?? gate.dir.road)), 0),
                crossPerLanePerMin: info.crossGates.reduce((max, gate) => Math.max(max, (arrivals.get(gate) ?? 0) * this._criticalLaneShareAt(gate, gate.dir.road)), 0),
                /** Per road (0 arterial, 1 cross): the busiest protected-turn lane's flow - the q of its turn stage. */
                turnPerLanePerMin: info.turnStages.map((stage) => (stage ? stage.gates.reduce((max, gate) => Math.max(max, this._turnLaneFlow(gate, arrivals.get(gate) ?? 0)), 0) : 0)),
            });
        }
        return flows;
    }

    /**
     * Webster's q is per lane of the critical lane group (Webster 1958), so it's
     * the busiest lane's flow - not the approach's flow over its lane count,
     * which understates it wherever lane use funnels most cars into fewer lanes
     * (a 2-lane approach whose straight-and-right lane takes nearly everything
     * because the road narrows past the junction). Turn shares are the same
     * ones the turn rolls use (_rollTurnPlan(), _rollConnectorTurnPlan()).
     */
    _criticalLaneShareAt(gate, road) {
        // An approach fed by a narrower road only has the lanes that road lines up with (corridor.js's coveredLanes).
        const mainSlots = Array.from({ length: road.lanes }, (_, j) => road.kerbSlots + j);
        const covered = gate.approach?.coveredLanes?.map((j) => road.kerbSlots + j);
        if (!gate.slotLaneUse) return 1 / (covered?.length ?? road.lanes);

        const slots = gate.slotLaneUse.map((_, slot) => slot).filter((slot) => gate.slotLaneUse[slot].length && (!covered || !mainSlots.includes(slot) || covered.includes(slot)));
        return criticalLaneShare(gate.slotLaneUse, slots, this._movementShares(gate));
    }

    /**
     * The share of `gate`'s arriving flow making each movement - the turn shares are the ones the turn rolls use,
     * or under destination routing the routed flows' own split.
     */
    _movementShares(gate) {
        const routed = this.routingActive ? this.routingModel.movementFlowByGate.get(gate) : null;
        if (routed?.total) return { straight: routed.straight / routed.total, left: routed.left / routed.total, right: routed.right / routed.total };
        const options = this._allowedTurnOptions(gate);
        const turnShare = !options.length
            ? 0
            : gate.connector
              ? gate.approach?.noStraight
                  ? 1
                  : gate.connector.turnChance
              : gate.node.connectorId
                ? this.connectorsById.get(gate.node.connectorId).crossChance
                : 0;
        const shares = { straight: 1 - turnShare, left: 0, right: 0 };
        for (const option of options) shares[option.movement] += turnShare / options.length;
        if (gate.slipJoin && shares.left > 0 && shares.left < 1) {
            // The left turners took the slip road: the rest are what reaches the stop line.
            const rest = 1 - shares.left;
            shares.straight /= rest;
            shares.right /= rest;
            shares.left = 0;
        }
        return shares;
    }

    /** The flow (veh/min) in each lane of `gate`'s protected turn: its share of the `arrivalPerMin` arriving, over the lanes that only make that turn. */
    _turnLaneFlow(gate, arrivalPerMin) {
        const { movement } = gate.turnPhase;
        const lanes = gate.slotLaneUse.filter((moves) => isTurnOnlyLane(moves, movement)).length;
        return lanes ? (arrivalPerMin * this._movementShares(gate)[movement]) / lanes : 0;
    }

    /**
     * Webster input for each road's protected-turn stage at `info`'s junction (phasePlan.js):
     * `{ demand, weight }`, or null for a road with none. q is its busiest turn lane's flow,
     * s the road's saturation flow, as for its through stage.
     */
    _turnStagesAt(info) {
        const flow = this._plannedApproachFlows().get(info.node.id);
        return info.turnStages.map((stage, phase) =>
            stage
                ? {
                      demand: {
                          spawnRatePerLanePerMin: flow.turnPerLanePerMin[phase],
                          saturationFlowPerLanePerHour: stage.gates[0].connector?.demand.saturationFlowPerLanePerHour ?? this.arterialState.get(info.arterial.id).saturationFlowPerLanePerHour,
                      },
                      weight: stage.weight,
                  }
                : null
        );
    }

    /** The turns out of `roads`' gates this pass, by the road they turn into: `[{ entryDistanceM, perMin }]` in the order they were found. */
    _plannedTurnIns(roads, arrivals) {
        const turnIns = new Map();
        for (const road of roads) {
            for (const gate of road.gates) {
                const { options, share } = this._gateTurns(gate, road);
                if (!options.length) continue;
                const turningOff = (arrivals.get(gate) ?? 0) * share;
                for (const option of options) {
                    const key = road.turnInKey(option);
                    if (!turnIns.has(key)) turnIns.set(key, []);
                    turnIns.get(key).push({ entryDistanceM: option.entryDistanceM, perMin: turningOff / options.length });
                }
            }
        }
        return turnIns;
    }

    /** Walks one road's gates in order: record what arrives at each, drop its turners, pick up whatever turns in before the next. */
    _plannedRoadFlows(road, turnIns, arrivals) {
        // Peel-offs (partway joins off this road) take their share wherever they sit.
        road.divergedPerMin = {};
        const peelOff = (flow, fromM, toM) => {
            for (const join of this.divergesFrom.get(road.key) ?? []) {
                if (join.fromAtM <= fromM || join.fromAtM > toM) continue;
                // A slip road takes the left turners, ahead of the gate they would have turned at.
                const share = join.slip ? this._slipShare(join, road) : join.share;
                road.divergedPerMin[join.to.key] = flow * share;
                flow -= flow * share;
            }
            return flow;
        };
        const merging = (fromM, toM) =>
            (this.mergesInto.get(road.key) ?? [])
                .filter((join) => join.toAtM > fromM && join.toAtM <= toM)
                .reduce((sum, join) => sum + (road.exitOf(join.from.key) ?? 0), 0);
        const firstStopM = road.gates[0]?.stopLineDistanceM ?? Infinity;
        let flow = peelOff(road.spawnPerMin, -Infinity, firstStopM) + merging(-Infinity, firstStopM);
        road.exitPerMin = flow;
        road.gates.forEach((gate, i) => {
            arrivals.set(gate, flow);
            const next = road.gates[i + 1];
            const turningIn = turnIns
                .filter((t) => t.entryDistanceM > gate.stopLineDistanceM && (!next || t.entryDistanceM < next.stopLineDistanceM))
                .reduce((sum, t) => sum + t.perMin, 0);
            const share = this._gateTurns(gate, road).share;
            const nextStopM = next ? next.stopLineDistanceM : Infinity;
            flow = peelOff(road.lose(flow, share) + turningIn, gate.stopLineDistanceM, nextStopM) + merging(gate.stopLineDistanceM, nextStopM);
            // Past the last gate the flow leaves the map - or carries on into a joined road.
            if (!next) road.exitPerMin = flow;
        });
    }

    /** The share of a slip gate's flow that took the slip road before the stop line: the left turners (zero where there's no left-turn lane). */
    _slipShare(join, road) {
        const options = this._allowedTurnOptions(join.gate);
        return options.some((o) => o.movement === 'left') ? road.turnShare(join.gate) / options.length : 0;
    }

    /**
     * The turns still made AT `gate`'s stop line and the share of the flow reaching it that makes them. At
     * a slip gate the left turners left earlier, so the rest turn at the rate they always did - out of a flow with
     * the left turners taken out.
     */
    _gateTurns(gate, road) {
        const all = this._allowedTurnOptions(gate);
        if (!all.length) return { options: all, share: 0 };
        const share = road.turnShare(gate);
        if (!gate.slipJoin) return { options: all, share };
        const options = all.filter((o) => o.movement !== 'left');
        const left = options.length < all.length ? share / all.length : 0;
        return { options, share: options.length && left < 1 ? ((share * options.length) / all.length) / (1 - left) : 0 };
    }

    /** The turns out of `gate` its lane use allows at all. */
    _allowedTurnOptions(gate) {
        return gate.turnOptions.filter((o) => gate.slotLaneUse && lanesAllowing(gate.slotLaneUse, o.movement).length);
    }

    _computePowerState() {
        if (this.power.manual) return 'load_shedding';
        if (this.power.scheduled) {
            const periodS = Math.max(1, this.power.periodMinutes) * 60;
            const offS = Math.max(0, this.power.offMinutes) * 60;
            if (this.simTimeS % periodS < offS) return 'load_shedding';
        }
        return 'normal';
    }

    _syncPowerState() {
        const next = this._computePowerState();
        if (next !== this.powerState) {
            this.powerState = next;
            this._rebuildAllControllers();
        }
    }

    _rebuildAllControllers() {
        for (const arterial of this.layout.arterials) {
            this._rebuildControllersForArterial(arterial.id);
        }
    }

    /** Mode or power-state change: every node on this arterial gets a fresh controller. */
    _rebuildControllersForArterial(arterialId) {
        const state = this.arterialState.get(arterialId);
        const nodeInfos = this.nodeInfosByArterial.get(arterialId) ?? [];

        if (this.powerState !== 'load_shedding' && state.mode === 'green_wave') {
            this._buildGreenWaveControllersFor(nodeInfos);
            for (const info of nodeInfos) if (!isSignalled(info)) this._rebuildController(info.node.id);
            return;
        }
        for (const info of nodeInfos) this._rebuildController(info.node.id);
    }

    /**
     * Demand change: re-derive signal timing without discarding phase state
     * where that would be wasteful. Fixed-time recomputes in place (keeps
     * wherever it currently is in the cycle); green wave is stateless (time
     * modulo cycle, no memory) so a full rebuild costs nothing; adaptive/none/
     * all-way-stop don't depend on demand at all.
     */
    _recomputeTimingForArterial(arterialId) {
        const state = this.arterialState.get(arterialId);
        const nodeInfos = this.nodeInfosByArterial.get(arterialId) ?? [];

        if (this.powerState !== 'load_shedding' && state.mode === 'green_wave') {
            this._buildGreenWaveControllersFor(nodeInfos);
            return;
        }
        for (const info of nodeInfos) {
            if (info.controllerType === 'fixed') {
                info.controller.recompute(this._arterialDemandAt(info.node), this._crossDemandFor(info.node), this._turnStagesAt(info));
            }
        }
    }

    /** Green wave across the arterial's signals - its roundabouts and stops keep their own control. */
    _buildGreenWaveControllersFor(allNodeInfos) {
        const nodeInfos = allNodeInfos.filter(isSignalled);
        if (!nodeInfos.length) return;
        const arterial = nodeInfos[0].arterial;
        const targetSpeedMps = (arterial.targetSpeedKph ?? 50) / 3.6;
        const controllers = buildGreenWaveControllers(
            nodeInfos,
            (node) => this._arterialDemandAt(node),
            (node) => this._crossDemandFor(node),
            (node) => this._turnStagesAt(this.nodesInfo.get(node.id)),
            targetSpeedMps
        );
        for (const info of nodeInfos) {
            info.controllerType = 'greenWave';
            info.controller = controllers.get(info.node.id);
        }
    }

    _rebuildController(nodeId) {
        const info = this.nodesInfo.get(nodeId);
        const arterialState = this.arterialState.get(info.arterial.id);
        const crossDemand = this._crossDemandFor(info.node);

        if (!info.arterialGates.length) {
            // Nothing arrives on the arterial side (a one-way street starting at a T): nothing to stop the cross street for.
            info.controllerType = 'none';
            info.controller = { phase: 0, inTurn: false, phaseState: 'green', isArterialGreen: () => true, isCrossGreen: () => true, tick: () => {} };
        } else if (info.node.control === 'roundabout') {
            // No signals to lose in load shedding - a roundabout runs the same either way.
            info.controllerType = 'roundabout';
            info.controller = new RoundaboutController();
            /** Cars let in and not yet out the other side - car id -> { car, approachId, passes, releasedAtS, entered }. */
            info.roundaboutOccupants = new Map();
            /** Cars waiting at the yield line - car -> when they got there (s). */
            info.roundaboutWaiting = new Map();
        } else if (info.node.control === 'stop') {
            // A stop street keeps its signs through load shedding too - there are no lights to lose.
            info.controllerType = 'minorStop';
            info.controller = new MinorStopController();
            info.allWayStopLockedUntilS = 0;
            info.allWayStopLegs = {
                0: { arrivedAtS: null, requiredDwellS: null },
                1: { arrivedAtS: null, requiredDwellS: null },
            };
        } else if (this.powerState === 'load_shedding' || info.node.control === 'allWayStop') {
            info.controllerType = 'allWayStop';
            info.controller = new AllWayStopController();
            // Fresh outage, fresh junction - don't let a lock timestamp or an
            // approach's arrival clock from a previous load-shedding window
            // (simTimeS never resets mid-run) leak into this one.
            /** Per approach (gate) -> { arrivedAtS, requiredDwellS } - see _updateAllWayStopLegClock(). */
            info.allWayStopLegs = new Map();
            /** Cars let into the box and not yet out the far side - car id -> { car, gate, road, releasedAtS, seenTurning }. */
            info.allWayStopOccupants = new Map();
        } else if (arterialState.mode === 'fixed') {
            info.controllerType = 'fixed';
            info.controller = new FixedTimeController(this._arterialDemandAt(info.node), crossDemand, this._turnStagesAt(info));
        } else if (arterialState.mode === 'adaptive') {
            info.controllerType = 'adaptive';
            info.controller = new AdaptiveController(undefined, info.turnStages.map((stage) => stage?.weight ?? null));
            info.callPersistenceS = [0, 0];
            info.radarSamples = [[], []];
        } else {
            // Defensive fallback only - green_wave is intercepted one level up in
            // _rebuildControllersForArterial and never reaches here while power is
            // normal. Free-flow placeholder for any other/unknown mode value.
            info.controllerType = 'none';
            info.controller = { phase: 0, inTurn: false, phaseState: 'green', isArterialGreen: () => true, isCrossGreen: () => true, tick: () => {} };
        }
    }

    _sampleArrival(spawnRatePerLanePerMin, rng = this.rng) {
        const lambdaPerSecond = Math.max(spawnRatePerLanePerMin, 0.01) / 60;
        return nextPoissonArrival(lambdaPerSecond, rng);
    }

    /**
     * The rate actually driving car arrivals right now. For a flat-demand
     * arterial/connector this is just its (possibly slider-adjusted)
     * `spawnRatePerLanePerMin`. For one with a configured fluctuation range
     * (corridor.js's `buildDemand()`), it's `fluctuatingDemand()` sampled at
     * the current sim time instead - deliberately NOT what fixedTime.js/
     * greenWave.js time their Webster plan to, so a fixed-time plan frozen
     * at the range's midpoint goes stale exactly like a real one would as
     * live conditions drift away from the historical count it was set from.
     */
    _liveSpawnRate(demand, designRatePerLanePerMin) {
        return demand.fluctuation ? fluctuatingDemand(this.simTimeS, demand.fluctuation) : designRatePerLanePerMin;
    }

    _spawnForCarriageway(carriageway, dt) {
        if (carriageway.fed || carriageway.noSpawn) return; // its traffic arrives from the road joined onto it, or turns in at its first junction
        const { arterial } = carriageway;
        const state = this.arterialState.get(arterial.id);
        const v0 = (arterial.targetSpeedKph ?? 50) / 3.6;

        this.carriagewayState.get(carriageway.id).lanes.forEach((lane, laneIndex) => {
            if (lane.isTurnLane) return;
            lane.timerS += dt;
            if (lane.timerS < lane.nextArrivalS) return;

            const nearestToEntry = lane.cars.reduce(
                (min, c) => (min === null || c.distanceM < min.distanceM ? c : min),
                null
            );
            if (nearestToEntry && nearestToEntry.distanceM < nearestToEntry.lengthM + SPAWN_CLEARANCE_M) {
                return; // no room yet - try again next tick without losing the elapsed timer
            }

            const vehicleType = this._rollVehicleType();
            const desiredSpeedMps = this._desiredSpeedFor(vehicleType, v0);
            const car = new Car({
                road: carriageway.road,
                lane: laneIndex,
                distanceM: 0,
                speedMps: desiredSpeedMps,
                desiredSpeedMps,
                colourIndex: Math.floor(this.rng.next() * CAR_PALETTE_SIZE),
                startupDelayS: this.rng.next() * MAX_STARTUP_DELAY_S,
                vehicleType,
            });
            car.speedMps = entrySpeedBehind(car, nearestToEntry);
            lane.cars.push(car);
            this.accounting.totalSpawned += 1;
            if (this.routingActive) this._assignTrip(car, carriageway.id);
            lane.timerS = 0;
            lane.nextArrivalS = this._sampleArrival(this._liveSpawnRate(arterial.demand, state.spawnRatePerLanePerMin), this._arrivalRng(carriageway.id));
        });
    }

    _stepCarriagewayCars(carriageway, dt) {
        const { arterial, gates } = carriageway;
        const state = this.carriagewayState.get(carriageway.id);
        const arterialState = this.arterialState.get(arterial.id);

        for (const lane of state.lanes) {
            lane.cars.sort((a, b) => b.distanceM - a.distanceM); // front of the queue first

            // Cross-routing (build step 9) first, as its own pass - a car that
            // diverts this tick is removed here and never IDM-steps on the
            // arterial again, so the index-based "car ahead = previous index"
            // lookup below never has to account for a car vanishing mid-loop.
            lane.cars = lane.cars.filter((car) => !this._maybeCrossRoute(carriageway, car));
        }

        // MOBIL lane changes (equations.js) next, its own pass over the whole
        // carriageway - a car needs visibility into every lane, not just its own,
        // to compare "what would my acceleration be here vs. next door", so
        // this can't be folded into the single-lane IDM loop below.
        if (state.lanes.length > 1) this._performLaneChanges(state, gates, dt);
        this._leaveClosedTurnLanes(state);

        for (const lane of state.lanes) {
            lane.cars.sort((a, b) => b.distanceM - a.distanceM); // a lane change may have just reordered this lane

            for (let i = 0; i < lane.cars.length; i += 1) {
                const car = lane.cars[i];
                const realAhead = i > 0 ? lane.cars[i - 1] : null;
                const signalAhead = this._signalAheadFor(gates, car);
                const pickupAhead = this._taxiPickupObstacle(carriageway, car, dt);
                const joinAhead = i === 0 ? this._joinObstacle(carriageway.id, car) : null;
                const ahead = nearestAhead(nearestAhead(nearestAhead(realAhead, signalAhead), pickupAhead), joinAhead);
                if (car.steppedTick !== this.tickNo) stepCar(car, ahead, dt, car.mergeDropBack ? mergeDropBackCap(car) : Infinity, this._turnApproachSpeedLimit(gates, car));
                car.steppedTick = this.tickNo;
                car.mergeDropBack = false;
                this._recordNodeClears(arterialState, gates, car);
            }

            if (this.routingActive) this._pullOffArrivals(carriageway.id, lane);
            this._peelOff(carriageway.id, state, lane);
            while (lane.cars.length && lane.cars[0].distanceM > carriageway.lengthM) {
                if (this.joinsFrom.has(carriageway.id)) {
                    if (!this._handOff(this.joinsFrom.get(carriageway.id), lane)) break; // no room on the next road yet
                    continue;
                }
                this._recordClear(arterial, lane.cars.shift());
            }
        }
    }

    /**
     * MOBIL lane changes (equations.js's mobilShouldChangeLane()) for one
     * tick across every lane of one carriageway. Snapshots each lane's car list up
     * front so every car is evaluated exactly once against the arrangement at
     * the start of the tick, regardless of what order lanes are visited in or
     * how many cars have already moved this tick.
     */
    _performLaneChanges(state, gates, dt) {
        const snapshotByLane = state.lanes.map((lane) => [...lane.cars]);

        for (const laneCars of snapshotByLane) {
            for (const car of laneCars) {
                if (car.laneChangeCooldownS > 0) {
                    car.laneChangeCooldownS = Math.max(0, car.laneChangeCooldownS - dt);
                    continue;
                }
                this._tryChangeLane(state, gates, car);
            }
        }
    }

    /**
     * Evaluate (and, if favourable, perform) a MOBIL lane change for one car
     * into whichever adjacent lane offers the bigger acceleration gain -
     * "behind a slow car/truck, and a faster lane is safely available" is
     * exactly the case this falls out of, without special-casing trucks at
     * all: a truck's lower desired speed (car.js's VEHICLE_TYPES) is what
     * makes following it a worse `accSelfBefore` than changing lanes.
     */
    _tryChangeLane(state, gates, car) {
        if (car.distanceM < LANE_CHANGE_MIN_DISTANCE_M) return;
        if (car.pickup) return; // a taxi pulling over, or stopped for passengers, stays put
        const nearestNode = this._nearestNodeAhead(gates, car);
        const plan = nearestNode && car.turnPlan?.nodeId === nearestNode.node.id ? car.turnPlan : null;
        const lanes = plan ? planLaneTargets(state.laneLayout, nearestNode.slotLaneUse, plan, car.distanceM) : null;

        if (lanes?.target.length && !lanes.target.includes(car.lane)) {
            const toStopM = nearestNode.stopLineDistanceM - car.distanceM;
            // Already in a lane that allows the movement, just not in the turn lane beside it: move over if there's room, never give up.
            const isInAllowedLane = lanes.allowed.includes(car.lane);
            if (!isInAllowedLane && toStopM < MANDATORY_GIVE_UP_M && car.speedMps < MERGE_DROP_BACK_MIN_SPEED_MPS) {
                car.turnPlan = this._resolvePlanAtStopLine(car, nearestNode.node.id, nearestNode.slotLaneUse, nearestNode.turnOptions, plan);
            } else if (toStopM > CROSS_DECISION_WINDOW_M) {
                this._tryMandatoryLaneChange(state, car, lanes.target, !isInAllowedLane);
            }
            return;
        }
        if (nearestNode && nearestNode.stopLineDistanceM - car.distanceM < LANE_CHANGE_STOPLINE_EXCLUSION_M) return;

        const allowedLanes = lanes?.target ?? null;
        const preferredLane = this._preferredLane(car, state.laneLayout);
        if (preferredLane !== null) {
            if (car.lane !== preferredLane) this._tryKeepToLane(state, car, preferredLane, allowedLanes);
            return;
        }

        const target = this._bestMobilLane(state, car, this._signalAheadFor(gates, car), allowedLanes);
        if (target !== null) this._moveToLane(state, car, target, VEHICLE_TYPES[car.vehicleType].laneChangeCooldownS ?? LANE_CHANGE_COOLDOWN_S);
    }

    /**
     * The adjacent lane (index) a MOBIL lane change should move `car` into -
     * whichever passes mobilShouldChangeLane() with the bigger acceleration
     * gain - or null to stay put. `state.lanes` must be sorted front-first; shared by
     * the arterials and the cross streets (`state` is an arterial's, or a connector direction's).
     */
    _bestMobilLane(state, car, signalAhead, allowedLanes = null) {
        const { lanes } = state;
        const laneIndex = car.lane;
        const { leader: curLeader, follower: curFollower } = neighborsInLane(lanes[laneIndex].cars, car);
        const curAhead = nearestAhead(curLeader, signalAhead);
        const accSelfBefore = carAcceleration(car, curAhead);

        let best = null;
        for (const targetIndex of [laneIndex - 1, laneIndex + 1]) {
            if (!slotOpenAt(state.laneLayout, targetIndex, car.distanceM)) continue;
            // A discretionary change never takes a car out of the lanes its planned movement is allowed from.
            if (allowedLanes && !allowedLanes.includes(targetIndex)) continue;
            const targetCars = lanes[targetIndex].cars;
            const { leader: tgtLeader, follower: tgtFollower } = neighborsInLane(targetCars, car);

            // Physical clearance check, on top of MOBIL's own acceleration-based
            // safety criterion below - stops a change that would leave two cars
            // visually overlapping even if the accelerations alone would allow it.
            if (!hasLaneChangeClearance(car, tgtLeader, tgtFollower)) continue;

            const tgtLeaderAhead = nearestAhead(tgtLeader, signalAhead);
            const accSelfAfter = carAcceleration(car, tgtLeaderAhead);
            const accNewFollowerBefore = tgtFollower ? carAcceleration(tgtFollower, tgtLeaderAhead) : 0;
            const accNewFollowerAfter = tgtFollower ? carAcceleration(tgtFollower, car) : 0;
            const accOldFollowerBefore = curFollower ? carAcceleration(curFollower, car) : 0;
            const accOldFollowerAfter = curFollower ? carAcceleration(curFollower, curAhead) : 0;

            const shouldChange = mobilShouldChangeLane(
                {
                    accSelfBefore,
                    accSelfAfter,
                    accNewFollowerBefore,
                    accNewFollowerAfter,
                    accOldFollowerBefore,
                    accOldFollowerAfter,
                },
                car.mobilParams
            );
            if (!shouldChange) continue;

            const weave = car.vehicleType === 'bmw' ? this.eventRng.next() * BMW_WEAVE_JITTER_MPS2 : 0;
            const gain = accSelfAfter - accSelfBefore + weave;
            if (!best || gain > best.gain) best = { targetIndex, gain };
        }

        return best?.targetIndex ?? null;
    }

    /** Random events: the lane a vehicle keeps to instead of choosing by MOBIL - the Ranger the fastest (outside) lane, a taxi the kerb lane. Null for everyone else. */
    _preferredLane(car, laneLayout) {
        if (car.vehicleType === 'ranger') return laneLayout.kerbSlots + laneLayout.mainLanes - 1;
        if (this._isPickupTaxi(car)) return laneLayout.kerbSlots;
        return null;
    }

    /** Steps one lane towards `preferredLane` when the gap is safe - no incentive test and no courtesy from the car behind, unlike a turn-lane merge. */
    _tryKeepToLane(state, car, preferredLane, allowedLanes) {
        const targetIndex = car.lane + Math.sign(preferredLane - car.lane);
        if (allowedLanes && !allowedLanes.includes(targetIndex)) return;
        const { leader, follower } = neighborsInLane(state.lanes[targetIndex].cars, car);
        if (!hasLaneChangeClearance(car, leader, follower)) return;
        if (follower && !mobilIsSafe(carAcceleration(follower, car), car.mobilParams)) return;
        this._moveToLane(state, car, targetIndex, MANDATORY_LANE_CHANGE_COOLDOWN_S);
    }

    /**
     * Random events: a taxi in the kerb lane pulls over every few hundred metres
     * to pick people up. Once it's due, it picks a spot it can brake for
     * comfortably - clear of the junctions either side - and that spot becomes
     * a stationary obstacle for this taxi alone, the same trick a red light
     * uses. It dwells there, then carries on. Cars behind it either queue or
     * find a gap next door through ordinary MOBIL.
     *
     * @returns the obstacle `{ distanceM, speedMps }` to stop at, or null.
     */
    _taxiPickupObstacle(carriageway, car, dt) {
        if (!this._isPickupTaxi(car)) return null;
        if (car.lane !== carriageway.laneLayout.kerbSlots) {
            car.pickup = null;
            return null;
        }
        if (car.pickup) return this._advanceTaxiPickup(car, dt);

        car.nextPickupM ??= car.distanceM + this._sampleTaxiPickupSpacingM();
        if (car.distanceM < car.nextPickupM) return null;

        const next = this._nearestNodeAhead(carriageway.gates, car);
        if (next && car.turnPlan?.nodeId === next.node.id && car.turnPlan.option) {
            car.nextPickupM = next.stopLineDistanceM + TAXI_PICKUP_JUNCTION_CLEARANCE_M; // turning off soon - pick up after the junction
            return null;
        }
        const atM = car.distanceM + car.lengthM / 2 + (car.speedMps * car.speedMps) / (2 * TAXI_PICKUP_DECEL_MPS2) + car.idmParams.s0;
        if (next && atM > next.stopLineDistanceM - TAXI_PICKUP_JUNCTION_CLEARANCE_M) {
            car.nextPickupM = next.stopLineDistanceM + TAXI_PICKUP_JUNCTION_CLEARANCE_M;
            return null;
        }
        if (atM > carriageway.lengthM - TAXI_PICKUP_JUNCTION_CLEARANCE_M) {
            car.nextPickupM = Infinity;
            return null;
        }

        car.pickup = { atM, dwellLeftS: null };
        return { distanceM: atM, speedMps: 0 };
    }

    _advanceTaxiPickup(car, dt) {
        const pickup = car.pickup;
        if (pickup.dwellLeftS === null) {
            const frontGapM = pickup.atM - (car.distanceM + car.lengthM / 2);
            if (car.stoppedNow && frontGapM <= car.idmParams.s0 + 1.5) {
                pickup.dwellLeftS = TAXI_PICKUP_MIN_DWELL_S + this.eventRng.next() * TAXI_PICKUP_DWELL_JITTER_S;
            }
        } else {
            pickup.dwellLeftS -= dt;
            if (pickup.dwellLeftS <= 0) {
                car.pickup = null;
                car.nextPickupM = car.distanceM + this._sampleTaxiPickupSpacingM();
                return null;
            }
        }
        return { distanceM: pickup.atM, speedMps: 0 };
    }

    /** Exponential spacing between one taxi's pickups, floored so it never stops twice in a row. */
    _sampleTaxiPickupSpacingM() {
        return TAXI_PICKUP_MIN_SPACING_M - Math.log(1 - this.eventRng.next()) * TAXI_PICKUP_MEAN_SPACING_M;
    }

    /**
     * A car whose planned movement isn't allowed from its current lane steps
     * one lane towards the nearest lane that allows it, as soon as the gap is
     * safe (mobilIsSafe - no incentive test, it has to change). A car that
     * still hasn't made it by the stop line gives up on the movement - see
     * _resolvePlanAtStopLine(). `isCourteous` false (a car that could make its
     * movement where it is, only moving into a turn lane) just waits for a gap -
     * nobody eases off to make one.
     */
    _tryMandatoryLaneChange(state, car, allowedLanes, isCourteous = true) {
        const nearestAllowed = allowedLanes.reduce((best, i) => (Math.abs(i - car.lane) < Math.abs(best - car.lane) ? i : best));
        const targetIndex = car.lane + Math.sign(nearestAllowed - car.lane);
        if (!slotOpenAt(state.laneLayout, targetIndex, car.distanceM)) return;
        const { leader, follower } = neighborsInLane(state.lanes[targetIndex].cars, car);
        if (!hasClearanceAhead(car, leader)) {
            if (isCourteous) car.mergeDropBack = true;
            return;
        }
        if (!hasClearanceBehind(car, follower) || (follower && !mobilIsSafe(carAcceleration(follower, car), car.mobilParams))) {
            if (isCourteous) follower.mergeDropBack = true; // the driver behind in that lane lets it in
            return;
        }
        this._moveToLane(state, car, targetIndex, MANDATORY_LANE_CHANGE_COOLDOWN_S);
    }

    /**
     * Safety net: a car still in a turn-lane slot where no turn lane exists any
     * more (it carried on past the stop line instead of turning) moves back
     * into the through lane beside it.
     */
    _leaveClosedTurnLanes(state) {
        state.lanes.forEach((lane, slot) => {
            if (!lane.isTurnLane) return;
            for (const car of lane.cars.filter((c) => !slotOpenAt(state.laneLayout, slot, c.distanceM))) {
                this._moveToLane(state, car, throughSlotBeside(state.laneLayout, slot), MANDATORY_LANE_CHANGE_COOLDOWN_S);
            }
        });
    }

    _moveToLane(state, car, targetIndex, cooldownS) {
        const fromCars = state.lanes[car.lane].cars;
        fromCars.splice(fromCars.indexOf(car), 1);
        car.laneChangeAnim = { fromLane: car.lane, elapsedS: 0 };
        car.lane = targetIndex;
        car.laneChangeCooldownS = cooldownS;
        const toCars = state.lanes[targetIndex].cars;
        toCars.push(car);
        toCars.sort((a, b) => b.distanceM - a.distanceM);
    }

    /** Native side-street arrivals (build step 9 gap) - separate from _maybeCrossRoute, which only diverts arterial cars onto a connector. */
    _spawnForConnector(connector, dt) {
        const state = this.connectorState.get(connector.id);
        const dirs = this.connectorDirs.get(connector.id);
        const v0 = connector.targetSpeedKph / 3.6;

        for (const dirKey of ['fwd', 'rev']) {
            const dir = dirs[dirKey];
            if (!dir.road.lanes || dir.noSpawn || dir.fed) continue; // one-way connector's unused direction, one starting at a T, or one fed by a join

            state[dirKey].lanes.forEach((lane, laneIndex) => {
                if (lane.isTurnLane) return;
                lane.timerS += dt;
                if (lane.timerS < lane.nextArrivalS) return;

                const nearestToEntry = lane.cars.reduce(
                    (min, c) => (min === null || c.distanceM < min.distanceM ? c : min),
                    null
                );
                if (nearestToEntry && nearestToEntry.distanceM < nearestToEntry.lengthM + SPAWN_CLEARANCE_M) {
                    return;
                }

                const vehicleType = this._rollVehicleType();
                const desiredSpeedMps = this._desiredSpeedFor(vehicleType, v0);
                const car = new Car({
                    road: dir.road,
                    lane: laneIndex,
                    distanceM: 0,
                    speedMps: desiredSpeedMps,
                    desiredSpeedMps,
                    colourIndex: Math.floor(this.rng.next() * CAR_PALETTE_SIZE),
                    startupDelayS: this.rng.next() * MAX_STARTUP_DELAY_S,
                    vehicleType,
                });
                car.speedMps = entrySpeedBehind(car, nearestToEntry);
                lane.cars.push(car);
                this.accounting.totalSpawned += 1;
                if (this.routingActive) this._assignTrip(car, `${connector.id}:${dirKey}`);
                lane.timerS = 0;
                lane.nextArrivalS = this._sampleArrival(this._liveSpawnRate(connector.demand, connector.demand.spawnRatePerLanePerMin), this._arrivalRng(`${connector.id}:${dirKey}`));
            });
        }
    }

    _stepConnectorCars(connector, dt) {
        const state = this.connectorState.get(connector.id);
        const dirs = this.connectorDirs.get(connector.id);
        const { routeLengthM } = connector; // stub tip to stub tip - matches renderer.js's drawn length

        for (const dirKey of ['fwd', 'rev']) {
            const dir = dirs[dirKey];
            const dirState = state[dirKey];
            if (!dir.road.lanes) continue; // one-way connector's unused direction

            // Turns onto the arterial first, as their own pass - same reason as
            // _stepArterialCars()'s cross-routing pass.
            for (const lane of dirState.lanes) {
                lane.cars.sort((a, b) => b.distanceM - a.distanceM);
                lane.cars = lane.cars.filter((car) => !this._maybeTurnOffConnector(connector, dir, dirKey, car));
            }
            if (dirState.lanes.length > 1) this._performConnectorLaneChanges(dir, dirState, dt);
            this._leaveClosedTurnLanes(dirState);

            for (const lane of dirState.lanes) {
                lane.cars.sort((a, b) => b.distanceM - a.distanceM);

                for (let i = 0; i < lane.cars.length; i += 1) {
                    const car = lane.cars[i];
                    const realAhead = i > 0 ? lane.cars[i - 1] : null;
                    const joinAhead = i === 0 ? this._joinObstacle(`${connector.id}:${dirKey}`, car) : null;
                    const ahead = nearestAhead(nearestAhead(realAhead, this._connectorObstacleAhead(dir, car)), joinAhead);
                    if (car.steppedTick !== this.tickNo) stepCar(car, ahead, dt, car.mergeDropBack ? mergeDropBackCap(car) : Infinity, this._connectorTurnApproachSpeedLimit(dir, car));
                    car.steppedTick = this.tickNo;
                    car.mergeDropBack = false;
                }

                if (this.routingActive) this._pullOffArrivals(`${connector.id}:${dirKey}`, lane);
                this._peelOff(`${connector.id}:${dirKey}`, dirState, lane);
                const join = this.joinsFrom.get(`${connector.id}:${dirKey}`);
                while (lane.cars.length && lane.cars[0].distanceM > routeLengthM) {
                    if (join) {
                        if (!this._handOff(join, lane)) break; // no room on the next road yet
                        continue;
                    }
                    const car = lane.cars.shift();
                    this.accounting.totalClearedNetwork += 1;
                    this._recordConnectorClear(connector, car);
                }
            }
        }
    }

    /**
     * Lane changes on one direction of a cross street - the same rules as the
     * arterials (_tryChangeLane()): a car planning a turn at the next junction
     * works its way into a lane whose lane use allows it, and otherwise changes
     * lanes by MOBIL without leaving the lanes its planned movement is allowed from.
     */
    _performConnectorLaneChanges(dir, dirState, dt) {
        const snapshotByLane = dirState.lanes.map((lane) => [...lane.cars]);

        for (const laneCars of snapshotByLane) {
            for (const car of laneCars) {
                if (car.laneChangeCooldownS > 0) {
                    car.laneChangeCooldownS = Math.max(0, car.laneChangeCooldownS - dt);
                    continue;
                }
                if (car.distanceM < LANE_CHANGE_MIN_DISTANCE_M) continue;
                // A lane that ends where this road joins a narrower one: merge out of it before the end,
                // courteously (whoever's alongside drops back to let it in, or it drops back itself).
                const keep = this._lanesContinuing(dir, dirState, car);
                if (keep) {
                    this._tryMandatoryLaneChange(dirState, car, keep, true);
                    continue;
                }
                // A car taking a peel-off ahead heads for the kerb lane first.
                const peel = this._divergeAhead(dir, car);
                if (peel && car.lane !== dirState.laneLayout.kerbSlots) {
                    this._tryMandatoryLaneChange(dirState, car, [dirState.laneLayout.kerbSlots], true);
                    continue;
                }
                const gate = this._nextGate(dir, car);
                const plan = gate?.approach && car.turnPlan?.nodeId === gate.node.id ? car.turnPlan : null;
                const lanes = plan ? planLaneTargets(dirState.laneLayout, gate.slotLaneUse, plan, car.distanceM) : null;

                if (lanes?.target.length && !lanes.target.includes(car.lane)) {
                    const toStopM = gate.stopLineDistanceM - car.distanceM;
                    const isInAllowedLane = lanes.allowed.includes(car.lane);
                    if (!isInAllowedLane && toStopM < MANDATORY_GIVE_UP_M && car.speedMps < MERGE_DROP_BACK_MIN_SPEED_MPS) {
                        car.turnPlan = this._resolvePlanAtStopLine(car, gate.node.id, gate.slotLaneUse, gate.turnOptions, plan);
                    } else if (toStopM > CROSS_DECISION_WINDOW_M) {
                        this._tryMandatoryLaneChange(dirState, car, lanes.target, !isInAllowedLane);
                    }
                    continue;
                }
                if (gate && gate.stopLineDistanceM - car.distanceM < LANE_CHANGE_STOPLINE_EXCLUSION_M) continue;

                const target = this._bestMobilLane(dirState, car, this._connectorObstacleAhead(dir, car), lanes?.target ?? null);
                if (target !== null) this._moveToLane(dirState, car, target, VEHICLE_TYPES[car.vehicleType].laneChangeCooldownS ?? LANE_CHANGE_COOLDOWN_S);
            }
        }
    }

    /** The next junction ahead of a car on connector direction `dir`, or null once it has passed both. */
    _nextGate(dir, car) {
        return dir.gates.find((gate) => gate.stopLineDistanceM > car.distanceM) ?? null;
    }

    /**
     * Whatever stops a connector car at a junction ahead: its own hold while
     * waiting to turn, or a signal/all-way stop. A connector runs through two
     * real intersections in sequence - a green at the near one still lets the
     * car see a red at the far one.
     */
    _connectorObstacleAhead(dir, car) {
        for (const gate of dir.gates) {
            if (gate.stopLineDistanceM <= car.distanceM) continue;
            if (car.turnPlan?.nodeId === gate.node.id && car.turnPlan.blockedSinceS != null) {
                return { distanceM: gate.stopLineDistanceM, speedMps: 0, isSignal: true, nodeId: gate.node.id, controllerType: gate.info.controllerType };
            }
            const obstacle = this._connectorSignalAhead(gate.info, gate.stopLineDistanceM, car, gate.approach?.id, gate.phase);
            if (obstacle) return obstacle;
        }
        return null;
    }

    /** Same as _turnApproachSpeedLimit(), for a cross-street car turning onto the arterial (or nearing a roundabout). */
    _connectorTurnApproachSpeedLimit(dir, car) {
        const gate = this._nextGate(dir, car);
        if (!gate) return Infinity;
        const roundaboutLimit = roundaboutApproachSpeedLimit(car, gate);
        const option = car.turnPlan?.option;
        if (!option || gate.node.id !== car.turnPlan.nodeId) return roundaboutLimit;
        return Math.min(roundaboutLimit, turnApproachSpeedLimit(car, option.movement, gate.stopLineDistanceM - car.distanceM));
    }

    /**
     * Cross-street turn planning and execution - the mirror of
     * _maybeCrossRoute(). As a junction becomes the next one ahead the car
     * decides whether to turn onto its arterial (the connector's `turnChance`,
     * if its approach's lane use allows that turn at all); at the stop line,
     * once allowed in, its lane decides, exactly as on the arterial.
     *
     * @returns true if the car left the connector (caller drops it from its lane).
     */
    _maybeTurnOffConnector(connector, dir, dirKey, car) {
        const gate = this._nextGate(dir, car);
        if (!gate?.approach) return false;
        const nodeId = gate.node.id;
        if (car.turnPlan?.nodeId !== nodeId) car.turnPlan = this._planAt(car, gate, () => (gate.phase === 0 ? this._rollTurnPlan(gate) : this._rollConnectorTurnPlan(connector, gate)));
        if (car.crossRollNodeId === nodeId) return false;

        if (gate.stopLineDistanceM - car.distanceM > CROSS_DECISION_WINDOW_M) return false;
        const mayEnter = entersByReleaseAt(gate.info.controllerType, gate.phase) ? car.releasedNodeIds.has(nodeId) : this._mayProceed(gate, car);
        if (!mayEnter) return false;

        car.turnPlan = this._resolvePlanAtStopLine(car, nodeId, gate.slotLaneUse, gate.turnOptions, car.turnPlan);
        const ringTarget = gate.info.controllerType === 'roundabout' ? this._roundaboutTarget(car, gate) : null;
        if (ringTarget) {
            if (this._driveIntoRoundabout(car, gate, ringTarget)) return true;
            this._holdForTurn(car, nodeId, false); // its way out is backed up - wait at the yield line
            return false;
        }
        if (!car.turnPlan.option) {
            car.crossRollNodeId = nodeId;
            return false;
        }
        // Off a road arriving along the arterial's line, the turn is onto the cross street.
        if (car.turnPlan.option.connectorId ? this._divertCarToConnector(car, gate, car.turnPlan.option) : this._divertCarToArterial(car, gate, connector, dirKey)) return true;

        this._holdForTurn(car, nodeId, !gate.approach.noStraight && isThroughSlot(dir.laneLayout, car.lane));
        return false;
    }

    /** Mirror of _rollTurnPlan(): `turnChance`, then uniformly among the turns onto the arterial the approach's lane use allows. */
    _rollConnectorTurnPlan(connector, gate) {
        const straight = { nodeId: gate.node.id, movement: 'straight', option: null };
        const options = this._allowedTurnOptions(gate);
        if (!options.length) return straight;
        // At a T there's no straight on, so every car turns.
        if (!gate.approach.noStraight && this.rng.next() >= connector.turnChance) return straight;
        const option = options.length === 1 ? options[0] : options[Math.floor(this.rng.next() * options.length)];
        return { nodeId: gate.node.id, movement: option.movement, option };
    }

    /**
     * Starts a cross-street car's turn onto the arterial - the mirror of
     * _divertCarToConnector(): a curved path through the junction into the
     * arterial lane its turning lane pairs with (turnTargetLane()). A
     * right turn off a two-way street crosses the oncoming half, so it also
     * waits for a gap in oncoming traffic.
     */
    _divertCarToArterial(car, gate, connector, dirKey) {
        const { node } = gate;
        const turnOption = car.turnPlan.option;
        const arterial = gate.info.arterial;
        const carriageway = this.carriagewaysById.get(turnOption.carriagewayId);
        const from = carWorldPoint(car);
        const fromHeading = roadPointAt(car.road, car.distanceM).heading;
        const direct = turnTargetLane(gate.slotLaneUse, car.lane, turnOption.movement, carriageway.laneLayout);
        const landing = this._turnLanding(carriageway.id, turnOption.movement, {
            road: carriageway.road,
            lanes: this.carriagewayState.get(carriageway.id).lanes,
            laneIndex: direct,
            exitDistanceM: this._turnExitDistance(from, fromHeading, carriageway.road, direct, turnOption.entryDistanceM + node.crossRoadWidthM / 2),
            fields: { carriagewayId: carriageway.id },
            speedKph: arterial.targetSpeedKph,
        });
        const { laneIndex, exitDistanceM } = landing;
        const pathKey = `${node.id}:${connector.id}:${dirKey}->${carriageway.id}:${laneIndex}`;

        const turnAhead = this.turningCars.some((c) => c.turnPath.key === pathKey && c.distanceM < (c.lengthM + car.lengthM) / 2 + SPAWN_CLEARANCE_M);
        if (turnAhead || this._turnExitBlocked(landing.lanes, laneIndex, exitDistanceM, car.lengthM)) return false;
        const mustYield = turnOption.movement === 'right' ? () => this._oncomingConnectorBlocksTurn(connector, dirKey, node, gate) : null;
        const waitInBox = Boolean(mustYield?.());
        if (waitInBox && !this._mayWaitInBox(gate)) return false;

        const exit = lanePoint(landing.road, laneIndex, exitDistanceM);
        const path = buildTurnPath(from, fromHeading, exit.point, exit.heading);
        this.turningCars.push(
            carryTripStats(car, new Car({
                id: car.id,
                road: landing.road,
                lane: laneIndex,
                distanceM: 0, // along the turn path until it joins the lane
                speedMps: car.speedMps,
                desiredSpeedMps: this._desiredSpeedFor(car.vehicleType, landing.speedKph / 3.6),
                colourIndex: car.colourIndex,
                startupDelayS: this.rng.next() * MAX_STARTUP_DELAY_S,
                vehicleType: car.vehicleType,
                turnPath: {
                    ...path,
                    key: pathKey,
                    ...landing.fields,
                    exitDistanceM,
                    movement: turnOption.movement,
                    speedLimitMps: turnSpeedMps(car, turnOption.movement),
                    ...(waitInBox ? this._boxWait(path, gate, mustYield) : {}),
                },
            }))
        );
        return true;
    }

    /** True if the other direction of a two-way connector has a vehicle in, or about to reach, `node` - see _oncomingBlocksTurn(). */
    _oncomingConnectorBlocksTurn(connector, dirKey, node, fromGate) {
        if (node.crossSplit) {
            // Two roads meet here: the oncoming traffic is whatever approaches on the other arm.
            const opposing = fromGate.info.crossGates.find((g) => g !== fromGate && g.approach);
            if (!opposing) return false;
            return this._oncomingBlocksTurn(this.connectorState.get(opposing.connector.id)[opposing.dirKey].lanes, opposing, node.arterialRoadWidthM, (car) =>
                this._connectorSignalAhead(opposing.info, opposing.stopLineDistanceM, car, opposing.approach?.id, opposing.phase)
            );
        }
        const oppositeKey = dirKey === 'fwd' ? 'rev' : 'fwd';
        const opposite = this.connectorDirs.get(connector.id)[oppositeKey];
        if (!opposite.road.lanes) return false;
        const gate = opposite.gates.find((g) => g.node.id === node.id);
        return this._oncomingBlocksTurn(this.connectorState.get(connector.id)[oppositeKey].lanes, gate, node.arterialRoadWidthM, (car) =>
            this._connectorSignalAhead(gate.info, gate.stopLineDistanceM, car, gate.approach?.id, gate.phase)
        );
    }

    /** Same for the other direction of a two-way arterial, for an arterial car turning right across it. */
    _oncomingArterialBlocksTurn(gate) {
        const h = gate.approach.heading;
        const opposite = gate.info.arterialGates.find((g) => g !== gate && g.approach.heading.x * h.x + g.approach.heading.y * h.y < -0.5);
        if (!opposite) return false;
        if (opposite.carriageway) {
            return this._oncomingBlocksTurn(this.carriagewayState.get(opposite.carriageway.id).lanes, opposite, gate.node.crossRoadWidthM, (car) => this._signalAheadFor([opposite], car));
        }
        return this._oncomingBlocksTurn(this.connectorState.get(opposite.connector.id)[opposite.dirKey].lanes, opposite, gate.node.crossRoadWidthM, (car) =>
            this._connectorSignalAhead(opposite.info, opposite.stopLineDistanceM, car, opposite.approach.id, 0)
        );
    }

    /**
     * True if an oncoming vehicle in `lanes` is in the junction at `gate` (its
     * own stop line, `junctionDepthM` deep) or would reach it within
     * ONCOMING_CRITICAL_GAP_S - unless `isHeld(car)`, held at its own red or
     * stop line. Oncoming right-turners don't conflict - in left-hand traffic
     * the two right turns pass each other.
     */
    _oncomingBlocksTurn(lanes, gate, junctionDepthM, isHeld) {
        for (const lane of lanes) {
            for (const car of lane.cars) {
                if (car.turnPlan?.nodeId === gate.node.id && car.turnPlan.movement === 'right') continue;
                const toStopM = gate.stopLineDistanceM - car.distanceM;
                if (toStopM < -junctionDepthM) continue; // already through the junction
                if (toStopM <= 0) return true; // in it now
                if (isHeld(car)) continue; // held at its own red/stop line
                if (toStopM / Math.max(car.speedMps, 0.5) < ONCOMING_CRITICAL_GAP_S) return true;
            }
        }
        return false;
    }

    /**
     * Keeps one all-way-stop approach's (arterial or cross, at one node) own
     * arrival clock current: stamps `arrivedAtS` and rolls a fresh randomised
     * `requiredDwellS` (the shared "hesitation" - see MIN_STOP_DWELL_S/
     * STOP_DWELL_JITTER_S) the moment the approach goes from nobody queued to
     * somebody queued, and clears both the moment it drains back to empty so
     * the next arrival there starts a genuinely fresh clock. Deliberately
     * PER-APPROACH, not per-car: an earlier per-car version rolled each
     * lane's own hesitation independently, which meant four cars that all
     * stopped within the same instant would peel off in two separate
     * batches, whichever pair's random dwell happened to finish first -
     * visibly wrong, since none of those lanes conflict with each other and
     * a real driver waits for the CAR that's been sitting there, not a coin
     * flip for their own lane. One shared clock per approach means every
     * lane on the winning side releases together the moment that ONE clock
     * is up, matching "any number of lanes go together, gated by whoever's
     * actually been there longest."
     */
    _updateAllWayStopLegClock(legState, hasQueue) {
        if (hasQueue && legState.arrivedAtS === null) {
            legState.arrivedAtS = this.simTimeS;
            legState.requiredDwellS = MIN_STOP_DWELL_S + this.rng.next() * STOP_DWELL_JITTER_S;
        } else if (!hasQueue) {
            legState.arrivedAtS = null;
            legState.requiredDwellS = null;
        }
    }

    /**
     * Once per tick, decide which all-way-stop approach(es) - if any - get
     * released past each node. One approach (one direction of one road, its
     * front car in each lane) at a time, first-come-first-served by its
     * arrival clock (`_updateAllWayStopLegClock` above) - a side only loses
     * its place once it drains, so a heavy side that refills faster can't
     * starve a light one. If the longest-waiting approach hasn't finished its
     * own hesitation, nobody else cuts in. The approach straight opposite may
     * go with it - drivers facing each other at a 4-way stop do - but only
     * when their paths don't cross: a right turn crosses the oncoming
     * straight/left (left-hand traffic), two right turns pass each other.
     *
     * Nobody is let in until every car released last time is out the far
     * side of the box (_allWayStopBoxOccupied()) - an earlier fixed-time
     * lock (box width / 6 m/s) expired while a car pulling away from a dead
     * stop was still crossing, so the next side drove through it, and
     * releasing a whole road (both directions, right-turners and all) at
     * once made the box run like a synchronised green.
     */
    _updateAllWayStopReleases() {
        let turningById = null;
        for (const info of this.nodesInfo.values()) {
            if (info.controllerType === 'minorStop') {
                this._updateMinorStopReleases(info);
                continue;
            }
            if (info.controllerType !== 'allWayStop') continue;

            const groups = this._allWayStopGroups(info);
            if (info.allWayStopOccupants.size) {
                turningById ??= new Map(this.turningCars.map((c) => [c.id, c]));
                if (this._allWayStopBoxOccupied(info, turningById)) continue;
            }
            const ready = groups.filter((g) => g.cars.length && this.simTimeS - g.leg.arrivedAtS >= g.leg.requiredDwellS);
            const waiting = groups.filter((g) => g.cars.length);
            if (!waiting.length) continue;

            const first = waiting.reduce((a, b) => (b.leg.arrivedAtS < a.leg.arrivedAtS ? b : a));
            if (!ready.includes(first)) continue; // the longest-waiting approach hasn't finished its own hesitation yet - hold, don't let another jump ahead
            const partner = ready.find((g) => g !== first && allWayStopOpposing(first.gate, g.gate) && !allWayStopPathsCross(info.node.id, first.cars, g.cars));
            for (const group of partner ? [first, partner] : [first]) {
                for (const car of group.cars) {
                    car.releasedNodeIds.add(info.node.id);
                    car.startupDelayS = RELEASE_HESITATION_MIN_S + this.rng.next() * RELEASE_HESITATION_JITTER_S;
                    car.startupTimerS = 0;
                    info.allWayStopOccupants.set(car.id, { car, gate: group.gate, road: car.road, releasedAtS: this.simTimeS, seenTurning: false });
                }
                group.leg.arrivedAtS = null;
                group.leg.requiredDwellS = null;
            }
        }
    }

    /** Each approach at all-way stop `info` with its front-of-queue cars and its own arrival clock (kept current here). */
    _allWayStopGroups(info) {
        const groups = [];
        for (const [phase, gates] of [[0, info.arterialGates], [1, info.crossGates]]) {
            for (const gate of gates) {
                const cars = this._allWayStopQueuedAtGate(info, gate, phase);
                this._pushFedAllWayStopCars(info, [gate], cars);
                if (!info.allWayStopLegs.has(gate)) info.allWayStopLegs.set(gate, { arrivedAtS: null, requiredDwellS: null });
                const leg = info.allWayStopLegs.get(gate);
                this._updateAllWayStopLegClock(leg, cars.length > 0);
                groups.push({ gate, phase, cars, leg });
            }
        }
        return groups;
    }

    /**
     * True while a car let into all-way stop `info` is still in (or pulling up to) the box - the rear of a car
     * going straight not yet past the far kerb of the road it crosses, or a turning car still on its turn path.
     * Drops the ones that are out; OCCUPANT_MAX_S is only a backstop against a car that vanished (despawned, or
     * handed onto a road this can't follow).
     */
    _allWayStopBoxOccupied(info, turningById) {
        const { node } = info;
        for (const [id, o] of info.allWayStopOccupants) {
            const turning = turningById.get(id);
            let inBox;
            if (turning) {
                o.seenTurning = true;
                inBox = true;
            } else if (o.seenTurning) {
                inBox = false; // finished its turn - it joins the new road past the far edge
            } else {
                const gateRoad = o.gate.carriageway?.road ?? o.gate.dir?.road;
                const crossedWidthM = o.gate.phase === 0 ? node.crossRoadWidthM : node.arterialRoadWidthM;
                if (o.car.road === gateRoad) inBox = o.car.distanceM - o.car.lengthM / 2 < o.gate.centreDistanceM + crossedWidthM / 2;
                else inBox = o.car.road === o.road; // still on the road feeding the approach
            }
            if (!inBox || this.simTimeS - o.releasedAtS > ALL_WAY_STOP_OCCUPANT_MAX_S) info.allWayStopOccupants.delete(id);
        }
        return info.allWayStopOccupants.size > 0;
    }

    /**
     * A stop street: the minor road's front car, once it has stopped for its hesitation (the all-way stop's clock), is
     * released when no arterial vehicle is in the junction or about to reach it - the arterial never waits.
     */
    _updateMinorStopReleases(info) {
        const queued = this._allWayStopQueuedCars(info, 1);
        this._updateAllWayStopLegClock(info.allWayStopLegs[1], queued.length > 0);
        if (!queued.length || this.simTimeS < (info.allWayStopLockedUntilS ?? 0)) return;
        const legState = info.allWayStopLegs[1];
        if (this.simTimeS - legState.arrivedAtS < legState.requiredDwellS) return;
        if (this._arterialBlocksMinorStop(info)) return;

        for (const car of queued) {
            car.releasedNodeIds.add(info.node.id);
            car.startupDelayS = RELEASE_HESITATION_MIN_S + this.rng.next() * RELEASE_HESITATION_JITTER_S;
            car.startupTimerS = 0;
        }
        legState.arrivedAtS = null;
        legState.requiredDwellS = null;
        info.allWayStopLockedUntilS = this.simTimeS + junctionClearTimeS(info.node) * MINOR_STOP_LOCK_SHARE;
    }

    /** True if an arterial vehicle is in `info`'s junction or would reach its stop line within MINOR_STOP_CRITICAL_GAP_S - the minor road waits. */
    _arterialBlocksMinorStop(info) {
        for (const gate of info.arterialGates) {
            for (const lane of this._gateLanes(gate)) {
                for (const car of lane.cars) {
                    const toStopM = gate.stopLineDistanceM - car.distanceM;
                    if (toStopM < -info.node.crossRoadWidthM) continue; // already through
                    if (toStopM <= 0) return true; // in it now
                    if (toStopM / Math.max(car.speedMps, 1) < MINOR_STOP_CRITICAL_GAP_S) return true;
                }
            }
        }
        return false;
    }

    /**
     * The one car per lane/direction (arterial `phase` 0, cross street
     * `phase` 1) currently at the TRUE front of its queue for `info.node`
     * specifically - i.e. the virtual all-way-stop obstacle, not a real car
     * ahead of it, is what it's actually braking for right now. Cars further
     * back in the same lane, still queued behind that front car, are
     * deliberately excluded: they're not yet independently blocked by this
     * node at all (a real car - the one ahead of them - is the nearer
     * obstacle), so they don't belong in this approach's release group yet
     * either; they join it themselves once they reach the front. The whole
     * group's shared hesitation clock lives on `info.allWayStopLegs`, not on
     * individual cars - see `_updateAllWayStopLegClock()`.
     */
    _allWayStopQueuedCars(info, phase) {
        const gates = phase === 0 ? info.arterialGates : info.crossGates;
        const result = gates.flatMap((gate) => this._allWayStopQueuedAtGate(info, gate, phase));
        this._pushFedAllWayStopCars(info, gates, result);
        return result;
    }

    /** _allWayStopQueuedCars() for one approach `gate` - its own lanes only, not the roads joined onto it. */
    _allWayStopQueuedAtGate(info, gate, phase) {
        const result = [];
        const lanes = phase === 0 ? this._gateLanes(gate) : this.connectorState.get(gate.connector.id)[gate.dirKey].lanes;
        for (const lane of lanes) {
            for (let i = 0; i < lane.cars.length; i += 1) {
                const car = lane.cars[i];
                if (!car.stoppedNow) continue;
                // Same real-leader-vs-virtual-signal resolution _stepCarriagewayCars()
                // itself uses (lane.cars is front-first) - a car queued behind a
                // REAL car ahead of it isn't yet the true front of the queue for
                // this node, so it isn't counted as part of this approach yet.
                const realAhead = i > 0 ? lane.cars[i - 1] : null;
                const signal = phase === 0 && gate.carriageway ? this._signalAheadFor(gate.carriageway.gates, car) : this._connectorSignalAheadOnDir(gate.dir, car);
                const ahead = nearestAhead(realAhead, signal);
                if (ahead?.isSignal && ahead.nodeId === info.node.id) result.push(car);
            }
        }
        return result;
    }

    /** Front-of-lane cars on a road joined onto one of `gates`' roads, held at its end by this node's all-way stop. */
    _pushFedAllWayStopCars(info, gates, result) {
        for (const gate of gates) {
            const join = this.feedersByGate.get(gate);
            if (!join) continue;
            for (const lane of join.from.lanes()) {
                const car = lane.cars[0];
                if (!car?.stoppedNow) continue;
                const ahead = this._joinObstacle(join.from.key, car);
                if (ahead?.isSignal && ahead.nodeId === info.node.id) result.push(car);
            }
        }
    }

    /**
     * Once per tick, at each roundabout: lets in the cars nearing their yield
     * line (within ROUNDABOUT_ENTRY_WINDOW_M) that have nobody to give way to -
     * no car coming round the ring that is about to pass in front of their
     * entry (traffic circulates clockwise, so that's traffic from the right:
     * see _roundaboutArmsPassed() and _roundaboutTrafficComing()). Longest-waiting first, each car let in
     * counting at once for the ones after it. Once a driver has waited
     * ROUNDABOUT_MAX_YIELD_S, only their approach is let in until they're in -
     * the gap a steady stream eventually leaves them. Leaves
     * `roundaboutOpenTo`, the approaches that could go right now, so a car
     * the roundabout would let in doesn't brake for the yield line on its way up
     * (see _roundaboutHolds()).
     */
    _updateRoundaboutReleases() {
        let turningById = null;
        for (const info of this.nodesInfo.values()) {
            if (info.controllerType !== 'roundabout') continue;
            if (info.roundaboutOccupants.size) turningById ??= new Map(this.turningCars.map((c) => [c.id, c]));
            this._pruneRoundaboutOccupants(info, turningById);

            const arriving = this._roundaboutArrivals(info);
            const arrivingCars = new Set(arriving.map((a) => a.car));
            for (const car of info.roundaboutWaiting.keys()) if (!arrivingCars.has(car)) info.roundaboutWaiting.delete(car);
            for (const { car } of arriving) if (!info.roundaboutWaiting.has(car)) info.roundaboutWaiting.set(car, this.simTimeS);
            arriving.sort((a, b) => info.roundaboutWaiting.get(a.car) - info.roundaboutWaiting.get(b.car));

            const overdue = arriving.find((a) => this.simTimeS - info.roundaboutWaiting.get(a.car) >= ROUNDABOUT_MAX_YIELD_S);
            const mayGo = (approachId) => (!overdue || approachId === overdue.approachId) && !this._roundaboutTrafficComing(info, approachId);

            for (const a of arriving) {
                if (!mayGo(a.approachId)) continue;
                a.car.releasedNodeIds.add(info.node.id);
                info.roundaboutWaiting.delete(a.car);
                info.roundaboutOccupants.set(a.car.id, {
                    car: a.car,
                    approachId: a.approachId,
                    passes: this._roundaboutArmsPassed(info, a.approachId, a.car.turnPlan?.nodeId === info.node.id ? a.car.turnPlan.movement : 'straight'),
                    releasedAtS: this.simTimeS,
                    entered: false,
                });
            }
            info.roundaboutOpenTo = new Set(info.node.approaches.map((approach) => approach.id).filter(mayGo));
        }
    }

    /**
     * True if a car in the roundabout (or let in and on its way) will drive past
     * `approachId`'s entry and is close to it - within ROUNDABOUT_GAP_M round the
     * ring before the point where a car from there would join, or right
     * alongside it. One that has gone past, or is further round, leaves the gap.
     */
    _roundaboutTrafficComing(info, approachId) {
        const { node } = info;
        const { circulatingRadiusM } = node.roundabout;
        info.roundaboutJoinAngles ??= new Map(
            node.approaches.map((a) => [a.id, Math.atan2(a.stopCentre.y - node.point.y, a.stopCentre.x - node.point.x) + ROUNDABOUT_MERGE_RAD])
        );
        const joinAngle = info.roundaboutJoinAngles.get(approachId);
        const alongsideRad = ROUNDABOUT_ALONGSIDE_M / circulatingRadiusM;
        for (const occupant of info.roundaboutOccupants.values()) {
            if (!occupant.passes.has(approachId)) continue;
            const p = carRenderPoint(occupant.car);
            const toJoinRad = (((joinAngle - Math.atan2(p.y - node.point.y, p.x - node.point.x)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            if (toJoinRad * circulatingRadiusM <= ROUNDABOUT_GAP_M || toJoinRad >= 2 * Math.PI - alongsideRad) return true;
        }
        return false;
    }

    /**
     * The approaches whose entry a car from `approachId` drives past on its way
     * round to its exit - clockwise (left-hand traffic), from where it comes in
     * to where it leaves: none turning left (the first exit), the next one going
     * straight, the next two turning right. By angle round the junction, so a T
     * or a skewed junction works the same. The exit's own approach isn't passed -
     * a car leaves there before it reaches the cars waiting to come in.
     */
    _roundaboutArmsPassed(info, approachId, movement) {
        const { node } = info;
        const approach = node.approaches.find((a) => a.id === approachId);
        const h = approach.heading;
        // y points south on the map, so rotating a heading left is (y, -x) and right (-y, x).
        const exitHeading = movement === 'left' ? { x: h.y, y: -h.x } : movement === 'right' ? { x: -h.y, y: h.x } : h;
        const armAngle = (a) => Math.atan2(-a.heading.y, -a.heading.x); // the side it comes in from
        const entry = armAngle(approach);
        const clockwiseFromEntry = (angle) => (((angle - entry) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const exit = clockwiseFromEntry(Math.atan2(exitHeading.y, exitHeading.x));
        const passes = new Set();
        for (const other of node.approaches) {
            if (other.id === approachId) continue;
            const at = clockwiseFromEntry(armAngle(other));
            if (at > ROUNDABOUT_ARM_TOLERANCE_RAD && at < exit - ROUNDABOUT_ARM_TOLERANCE_RAD) passes.add(other.id);
        }
        return passes;
    }

    /**
     * Drops the cars that are out the other side of the roundabout - they came
     * within its circle and have left it again (or never made it in, after
     * ROUNDABOUT_OCCUPANT_TIMEOUT_S). A car that turned there is a new Car on its
     * turn path (same id), so the record follows that one.
     */
    _pruneRoundaboutOccupants(info, turningById) {
        const { node } = info;
        const radiusM = node.roundabout.radiusM + 1;
        for (const [id, occupant] of info.roundaboutOccupants) {
            const turning = turningById?.get(id);
            if (turning) occupant.car = turning;
            const p = carRenderPoint(occupant.car);
            const inside = Math.hypot(p.x - node.point.x, p.y - node.point.y) <= radiusM;
            if (inside) occupant.entered = true;
            const gaveUp = !occupant.entered && this.simTimeS - occupant.releasedAtS > ROUNDABOUT_OCCUPANT_TIMEOUT_S;
            if ((occupant.entered && !inside) || gaveUp) info.roundaboutOccupants.delete(id);
        }
    }

    /** The car at the front of each lane into the roundabout that is within ROUNDABOUT_ENTRY_WINDOW_M of its yield line and not yet let in - with its approach. */
    _roundaboutArrivals(info) {
        const nodeId = info.node.id;
        const result = [];
        const consider = (car, toStopM, approachId) => {
            if (car && !car.releasedNodeIds.has(nodeId) && toStopM >= 0 && toStopM <= ROUNDABOUT_ENTRY_WINDOW_M) result.push({ car, approachId });
        };
        for (const gate of [...info.arterialGates, ...info.crossGates]) {
            if (!gate.approach) continue;
            const lanes = gate.carriageway ? this.carriagewayState.get(gate.carriageway.id).lanes : this.connectorState.get(gate.connector.id)[gate.dirKey].lanes;
            for (const lane of lanes) {
                // Front first, so the first one short of the line is the front of the queue.
                const car = lane.cars.find((c) => c.distanceM < gate.stopLineDistanceM && !c.releasedNodeIds.has(nodeId));
                if (car) consider(car, gate.stopLineDistanceM - car.distanceM, gate.approach.id);
            }
            // A road joined onto this one right before the roundabout queues for it too.
            const join = this.feedersByGate.get(gate);
            if (!join) continue;
            for (const lane of join.from.lanes()) {
                const car = lane.cars[0];
                if (car) consider(car, join.from.lengthM - car.distanceM + gate.stopLineDistanceM, gate.approach.id);
            }
        }
        return result;
    }

    /**
     * Where a car let into a roundabout at `gate` comes out: the road and lane
     * its plan takes it to - a turn's street, or straight on, the far side of
     * its own road - and that road's distance at the junction's centre. Null
     * where straight on is another road (a split junction): it drives through.
     */
    _roundaboutTarget(car, gate) {
        const { option, movement } = car.turnPlan;
        if (option?.connectorId) {
            const dir = this.connectorDirs.get(option.connectorId)[option.dirKey];
            return {
                road: dir.road,
                lanes: this.connectorState.get(option.connectorId)[option.dirKey].lanes,
                laneIndex: turnTargetLane(gate.slotLaneUse, car.lane, movement, dir.laneLayout),
                centreM: option.entryDistanceM,
                fields: { connectorId: option.connectorId, dirKey: option.dirKey },
                speedKph: this.connectorsById.get(option.connectorId).targetSpeedKph,
                movement,
                sameRoad: false,
            };
        }
        if (option?.carriagewayId) {
            const carriageway = this.carriagewaysById.get(option.carriagewayId);
            return {
                road: carriageway.road,
                lanes: this.carriagewayState.get(carriageway.id).lanes,
                laneIndex: turnTargetLane(gate.slotLaneUse, car.lane, movement, carriageway.laneLayout),
                centreM: option.entryDistanceM,
                fields: { carriagewayId: carriageway.id },
                speedKph: carriageway.arterial.targetSpeedKph,
                movement,
                sameRoad: false,
            };
        }
        if (gate.carriageway) {
            return {
                road: gate.carriageway.road,
                lanes: this.carriagewayState.get(gate.carriageway.id).lanes,
                laneIndex: car.lane,
                centreM: gate.centreDistanceM,
                fields: { carriagewayId: gate.carriageway.id },
                movement: 'straight',
                sameRoad: true,
            };
        }
        if (gate.node.crossSplit) return null;
        return {
            road: gate.dir.road,
            lanes: this.connectorState.get(gate.connector.id)[gate.dirKey].lanes,
            laneIndex: car.lane,
            centreM: gate.centreDistanceM,
            fields: { connectorId: gate.connector.id, dirKey: gate.dirKey },
            movement: 'straight',
            sameRoad: true,
        };
    }

    /**
     * Sends a car let into a roundabout round it (_roundaboutPath()) to
     * `target`. A car going straight on is the same car carrying on along its
     * own road (its wait and stop-line counts go with it); one turning off
     * starts afresh on its new street, exactly as at any other junction. False
     * - nothing moved - while the car ahead from the same entry is still
     * pulling away or there's no room where it comes out.
     */
    _driveIntoRoundabout(car, gate, target) {
        const { node } = gate;
        const exitDistanceM = target.centreM + node.roundabout.radiusM + ROUNDABOUT_EXIT_RUN_M;
        const key = `${node.id}:ring:${gate.approach.id}`;
        const entryAhead = this.turningCars.some((c) => c.turnPath.key === key && c.distanceM < (c.lengthM + car.lengthM) / 2 + SPAWN_CLEARANCE_M);
        if (entryAhead || this._turnExitBlocked(target.lanes, target.laneIndex, exitDistanceM, car.lengthM)) return false;

        const turnPath = {
            ...this._roundaboutPath(node, carWorldPoint(car), target.road, target.laneIndex, target.centreM, exitDistanceM),
            key,
            ...target.fields,
            movement: target.movement,
            exitDistanceM,
            speedLimitMps: (ROUNDABOUT_SPEED_KPH / 3.6) * VEHICLE_TYPES[car.vehicleType].desiredSpeedFactor,
            sameRoad: target.sameRoad,
            /** Round a roundabout - it follows whoever is ahead on the ring, not just cars from its own entry (_ringLeader()). */
            ringNodeId: node.id,
        };
        if (target.sameRoad) {
            car.turnPath = turnPath;
            car.lane = target.laneIndex;
            car.distanceM = 0; // along the ring until it rejoins its road
            car.laneChangeAnim = null;
            car.crossRollNodeId = node.id;
            this.turningCars.push(car);
            return true;
        }
        this.turningCars.push(
            carryTripStats(car, new Car({
                id: car.id,
                road: target.road,
                lane: target.laneIndex,
                distanceM: 0,
                speedMps: car.speedMps,
                desiredSpeedMps: this._desiredSpeedFor(car.vehicleType, target.speedKph / 3.6),
                colourIndex: car.colourIndex,
                startupDelayS: this.rng.next() * MAX_STARTUP_DELAY_S,
                vehicleType: car.vehicleType,
                turnPath,
            }))
        );
        return true;
    }

    /**
     * A car's way round a roundabout: from where it is at the yield line onto
     * the circulating line, clockwise round the island (left-hand traffic) to
     * its exit, out across the ring into its lane at the circle's edge, and on to
     * `exitDistanceM` along that road. Going straight on takes it half way
     * round, turning left a quarter, right three quarters.
     */
    _roundaboutPath(node, from, road, laneIndex, centreM, exitDistanceM) {
        const { radiusM, circulatingRadiusM } = node.roundabout;
        const c = node.point;
        const out = lanePoint(road, laneIndex, centreM + radiusM).point;
        const end = lanePoint(road, laneIndex, exitDistanceM).point;
        const angleOf = (p) => Math.atan2(p.y - c.y, p.x - c.x);
        const startAngle = angleOf(from);
        // y points south, so a growing angle runs clockwise on the map.
        let sweep = (((angleOf(out) - startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (sweep < 0.2) sweep += 2 * Math.PI; // back out the way it came: once round
        const lead = Math.min(ROUNDABOUT_MERGE_RAD, sweep / 3);
        const arc = sweep - 2 * lead;
        const steps = Math.max(4, Math.ceil((arc * circulatingRadiusM) / ROUNDABOUT_PATH_STEP_M));
        const points = [from];
        for (let i = 0; i <= steps; i += 1) {
            const angle = startAngle + lead + (arc * i) / steps;
            points.push({ x: c.x + Math.cos(angle) * circulatingRadiusM, y: c.y + Math.sin(angle) * circulatingRadiusM });
        }
        points.push(out, end);
        return buildPolylinePath(points);
    }

    /** True if the roundabout at `info` keeps a car on `approachId` at its yield line right now - it has someone to give way to. */
    _roundaboutHolds(info, approachId) {
        return !info.roundaboutOpenTo?.has(approachId);
    }

    /**
     * What a car nearing the end of a joined road sees on the road it's about to
     * join: the last car in the lane it will take, and - where that road's first
     * junction sits right at its start - that junction's signal. Both in the
     * car's own road's frame. Null when the road isn't joined or the end is
     * still far off.
     */
    _joinObstacle(key, car) {
        const join = this.joinsFrom.get(key);
        if (!join) return null;
        const offsetM = join.from.lengthM;
        if (offsetM - car.distanceM > JOIN_LOOKAHEAD_M) return null;

        const slot = this._joinTargetSlot(join, car);
        if (join.toAtM != null) return this._mergeObstacle(join, car, join.to.lanes()[slot]);
        const tail = lastCarIn(join.to.lanes()[slot]);
        const leader = tail ? { distanceM: offsetM + tail.distanceM, speedMps: tail.speedMps, lengthM: tail.lengthM } : null;
        return nearestAhead(leader, this._joinSignalObstacle(join, car));
    }

    /**
     * A car on a turn road merging partway into `lane`: it follows whoever is
     * just past the merge point, and - close to the end of its road - gives way
     * to a car on the main road that would reach the merge point too soon.
     */
    _mergeObstacle(join, car, lane) {
        const offsetM = join.from.lengthM;
        const { leader, follower } = aroundPoint(lane, join.toAtM);
        const ahead = leader ? { distanceM: offsetM + leader.distanceM - join.toAtM, speedMps: leader.speedMps, lengthM: leader.lengthM } : null;
        if (offsetM - car.distanceM < MERGE_WATCH_M && ((follower && !mergeGapBehind(follower, car, join.toAtM)) || this._turnComingInto(join.to.road, lane, join.toAtM))) {
            return nearestAhead(ahead, { distanceM: offsetM, speedMps: 0 });
        }
        return ahead;
    }

    /** Is a car still sweeping round a turn into `lane` of `road` about to come out within reach of `pointM` - a merge there has to wait for it. */
    _turnComingInto(road, lane, pointM) {
        return this.turningCars.some((c) => c.road === road && c.turnPath && Math.abs(c.turnPath.exitDistanceM - pointM) < 25 && this._turnTargetLanes(c.turnPath)[c.lane] === lane);
    }

    /** The signal (or all-way stop) at a fed gate right after the join, as it applies to `car` still on the road before it. */
    _joinSignalObstacle(join, car) {
        const gate = join.to.gates[0];
        if (!gate || this.feedersByGate.get(gate) !== join) return null;
        const offsetM = join.from.lengthM;
        if (join.to.kind === 'connector') return this._connectorSignalAhead(gate.info, offsetM + gate.stopLineDistanceM, car, gate.approach?.id, gate.phase);
        const proxy = { distanceM: car.distanceM - offsetM, turnPlan: car.turnPlan, releasedNodeIds: car.releasedNodeIds };
        const obstacle = this._signalAheadFor([gate], proxy);
        return obstacle ? { ...obstacle, distanceM: obstacle.distanceM + offsetM } : null;
    }

    /**
     * The lane a car will take on the road it's joining, chosen once and kept:
     * where that road's first junction is right at the join, a lane for the
     * movement it plans there (rolled now, as it would be on reaching that road);
     * otherwise the same lane counted from the median, so the kerb lane is the
     * one that ends where the road narrows (its cars merge over) or that opens
     * up where it widens (filled by later lane changes).
     */
    _joinTargetSlot(join, car) {
        if (car.joinSlot?.key === join.from.key) return car.joinSlot.slot;
        const { to, from } = join;
        if (join.toAtM != null) {
            // A turn road merges into the kerb lane.
            car.joinSlot = { key: from.key, slot: to.laneLayout.kerbSlots };
            return car.joinSlot.slot;
        }
        const lanes = to.lanes();
        const entryM = this._joinEntryDistance(join, 0);
        const open = (slot) => slotOpenAt(to.laneLayout, slot, entryM);
        let slots = [];
        const gate = this.feedersByGate.get(to.gates[0]) === join ? to.gates[0] : null;
        if (gate?.approach) {
            if (car.turnPlan?.nodeId !== gate.node.id) {
                car.turnPlan = this._planAt(car, gate, () => (to.kind === 'arterial' || gate.phase === 0 ? this._rollTurnPlan(gate) : this._rollConnectorTurnPlan(to.connector, gate)));
            }
            slots = lanesAllowing(gate.slotLaneUse, car.turnPlan.movement).filter(open);
            // Only into the lanes the narrower road behind actually lines up with (corridor.js's coveredLanes).
            const covered = gate.approach.coveredLanes?.map((j) => to.laneLayout.kerbSlots + j);
            if (covered) {
                const onGround = slots.filter((slot) => covered.includes(slot));
                slots = onGround.length ? onGround : covered;
            }
        } else {
            // A junction a short way along the road it joins (Duxbury's divided stretch before Jan Shoba): pick the lanes for
            // the movement it'll make there now, rather than landing on the median side and having to cross over in time.
            const ahead = to.gates.find((g) => g.stopLineDistanceM > entryM);
            if (ahead?.approach && ahead.stopLineDistanceM - entryM <= JOIN_PLAN_REACH_M) {
                if (car.turnPlan?.nodeId !== ahead.node.id) {
                    car.turnPlan = this._planAt(car, ahead, () => (to.kind === 'arterial' || ahead.phase === 0 ? this._rollTurnPlan(ahead) : this._rollConnectorTurnPlan(to.connector, ahead)));
                }
                slots = laneTargets(to.laneLayout, ahead.slotLaneUse, car.turnPlan.movement, entryM).target.filter(open);
            }
        }
        if (!slots.length) {
            // Lanes line up on the median side: a kerb lane is what a road gains or drops. A car that
            // has just turned onto a road that widens straight after keeps to the side it turned in
            // on - a left turn into the new kerb lane, a right turn into the median lane.
            const mainIndex = Math.max(0, Math.min(car.lane - from.laneLayout.kerbSlots, from.laneLayout.mainLanes - 1));
            const shifted = mainIndex + to.laneLayout.mainLanes - from.laneLayout.mainLanes;
            const turned = to.laneLayout.mainLanes > from.laneLayout.mainLanes && car.turnedIn?.road === from.road ? car.turnedIn.movement : null;
            const main = turned === 'left' ? 0 : turned === 'right' ? to.laneLayout.mainLanes - 1 : Math.max(0, Math.min(shifted, to.laneLayout.mainLanes - 1));
            slots = [to.laneLayout.kerbSlots + main];
        }
        const room = (slot) => {
            const tail = lastCarIn(lanes[slot]);
            return tail ? tail.distanceM - tail.lengthM / 2 : Infinity;
        };
        const slot = slots.reduce((best, s) => (room(s) > room(best) ? s : best), slots[0]);
        car.joinSlot = { key: from.key, slot };
        return slot;
    }

    /** Where on the joined road a car overshooting the end of the road before it by `overshootM` lands - never past that road's first stop line. */
    _joinEntryDistance(join, overshootM) {
        if (join.toAtM != null) return join.toAtM + Math.max(0, overshootM); // carry on past the merge point by however far it overshot its own road's end
        const gate = join.to.gates[0];
        const cap = gate && this.feedersByGate.get(gate) === join ? Math.max(0, gate.stopLineDistanceM - 0.3) : Infinity;
        return Math.min(Math.max(0, overshootM), cap);
    }

    /**
     * Moves the front car of `lane` (past the end of `join.from`) onto its lane
     * on `join.to` if there's room at the entry. Returns false - and holds the
     * car at the end of its road - when there isn't.
     */
    _handOff(join, lane) {
        const car = lane.cars[0];
        const slot = this._joinTargetSlot(join, car);
        const target = join.to.lanes()[slot];
        const entryM = this._joinEntryDistance(join, car.distanceM - join.from.lengthM);
        let blocked;
        if (join.toAtM != null) {
            const { leader, follower } = aroundPoint(target, entryM);
            blocked = (leader && leader.distanceM - (leader.lengthM + car.lengthM) / 2 - entryM < 0.5) || (follower && !mergeGapBehind(follower, car, entryM)) || this._turnComingInto(join.to.road, target, entryM);
        } else {
            const tail = lastCarIn(target);
            blocked = tail && tail.distanceM - (tail.lengthM + car.lengthM) / 2 - entryM < 0.5;
        }
        // Where lanes merge into one, cars take turns: one held at the end longer than this one goes first.
        const waitingLonger = join.from.lanes().some((other) => {
            const rival = other.cars[0];
            return rival && rival !== car && rival.joinSlot?.slot === slot && rival.joinHeldSinceS != null
                && (car.joinHeldSinceS == null || rival.joinHeldSinceS < car.joinHeldSinceS);
        });
        if (blocked || waitingLonger) {
            car.distanceM = join.from.lengthM;
            car.speedMps = 0;
            car.joinHeldSinceS ??= this.simTimeS;
            return false;
        }
        lane.cars.shift();
        const drawnAt = carWorldPoint(car);
        car.road = join.to.road;
        car.lane = slot;
        car.distanceM = entryM;
        car.joinSlot = null;
        car.joinHeldSinceS = null;
        car.turnedIn = null;
        this._glideFrom(car, drawnAt);
        if (join.to.kind === 'arterial') {
            const next = join.to.gates.findIndex((gate) => gate.stopLineDistanceM > car.distanceM);
            car.nextNodeIndex = next === -1 ? join.to.gates.length : next;
        }
        target.cars.push(car);
        target.cars.sort((a, b) => b.distanceM - a.distanceM);
        return true;
    }

    /**
     * The peel-off ahead that `car` has decided to take, if any - deciding (the
     * join's `share`) the first time it comes within DIVERGE_DECISION_M of one.
     */
    _divergeAhead(dir, car) {
        const key = this._dirKeyOf(dir);
        for (const join of this.divergesFrom.get(key) ?? []) {
            if (join.slip) continue; // taken from the left-turn lane, not decided by a share
            const toGoM = join.fromAtM - car.distanceM;
            if (toGoM < 0 || toGoM > DIVERGE_DECISION_M) continue;
            car.peelDecisions ??= new Map();
            if (!car.peelDecisions.has(join)) car.peelDecisions.set(join, car.trip ? this._routeTakesPeel(car, join) : this.rng.next() < join.share);
            if (car.peelDecisions.get(join)) return join;
        }
        return null;
    }

    /**
     * Moves cars that have just reached a peel-off they decided to take onto its road - or, with no room there, lets them carry on.
     * A share peel-off takes them from the kerb lane; a slip road takes whoever is in the left-turn lane (and only
     * once it can see a gap to merge into - see _slipEntryBlocked()).
     */
    _peelOff(key, dirState, lane) {
        const joins = this.divergesFrom.get(key);
        if (!joins) return;
        const kerbLane = dirState.lanes[dirState.laneLayout.kerbSlots];
        for (const join of joins) {
            if (join.slip ? !join.gate || !isTurnOnlyLane(join.gate.slotLaneUse?.[dirState.lanes.indexOf(lane)] ?? [], 'left') : lane !== kerbLane) continue;
            for (const car of [...lane.cars]) {
                if (car.distanceM < join.fromAtM || car.distanceM > join.fromAtM + 15) continue;
                if (!join.slip && !car.peelDecisions?.get(join)) continue;
                const target = join.to.lanes()[join.to.laneLayout.kerbSlots];
                const tail = lastCarIn(target);
                const entryM = car.distanceM - join.fromAtM;
                if (!join.slip) car.peelDecisions.delete(join);
                if (tail && tail.distanceM - (tail.lengthM + car.lengthM) / 2 - entryM < 0.5) {
                    if (car.trip) this._recordMissedTurn(car, 'peelNoRoom', `${key}@peel`, 'peel');
                    continue; // no room - it misses the turn
                }
                lane.cars.splice(lane.cars.indexOf(car), 1);
                const drawnAt = carWorldPoint(car);
                car.road = join.to.road;
                car.lane = join.to.laneLayout.kerbSlots;
                car.distanceM = entryM;
                car.turnPlan = null;
                this._glideFrom(car, drawnAt);
                target.cars.push(car);
                target.cars.sort((a, b) => b.distanceM - a.distanceM);
            }
        }
    }

    /**
     * After a hand-over onto another road, eases the drawn position sideways
     * from where the car was drawn on the old road into its new lane - the same
     * glide a lane change uses - instead of snapping across.
     */
    _glideFrom(car, drawnAt) {
        const { point, heading } = roadPointAt(car.road, car.distanceM);
        const normal = leftNormal(heading);
        car.laneChangeAnim = { fromOffsetM: (drawnAt.x - point.x) * normal.x + (drawnAt.y - point.y) * normal.y, elapsedS: 0 };
    }

    /**
     * The lanes that carry on, if `car` is in one that doesn't: this road joins
     * a narrower one (lanes line up on the median side, so its kerb lanes end),
     * the car is past its last junction and within MERGE_OUT_M of the end.
     */
    _lanesContinuing(dir, dirState, car) {
        const join = this.joinsFrom.get(this._dirKeyOf(dir));
        if (!join || join.toAtM != null || this.feedersByGate.get(join.to.gates[0]) === join) return null;
        const { kerbSlots, mainLanes } = dirState.laneLayout;
        const dropping = mainLanes - join.to.laneLayout.mainLanes;
        if (dropping <= 0 || car.lane >= kerbSlots + dropping) return null;
        if (join.from.lengthM - car.distanceM > MERGE_OUT_M || this._nextGate(dir, car)) return null;
        return Array.from({ length: mainLanes - dropping }, (_, i) => kerbSlots + dropping + i);
    }

    /** `conn:fwd`-style key of a connector direction object. */
    _dirKeyOf(dir) {
        if (!this._dirKeys) {
            this._dirKeys = new Map();
            for (const [id, dirs] of this.connectorDirs) for (const k of ['fwd', 'rev']) this._dirKeys.set(dirs[k], `${id}:${k}`);
        }
        return this._dirKeys.get(dir);
    }

    /** The first junction ahead on connector direction `dir` whose signal (or all-way stop) holds `car`, as a virtual stationary obstacle - or null. */
    _connectorSignalAheadOnDir(dir, car) {
        for (const gate of dir.gates) {
            const obstacle = this._connectorSignalAhead(gate.info, gate.stopLineDistanceM, car, gate.approach?.id, gate.phase);
            if (obstacle) return obstacle;
        }
        return null;
    }

    /** Nearest node ahead of `car`, resolved to a virtual stationary obstacle if that node currently blocks the arterial. */
    _signalAheadFor(gates, car) {
        const nearest = this._nearestNodeAhead(gates, car);
        if (!nearest) return null;

        // A car waiting for a gap to make its turn holds at the stop line whatever the signal shows.
        if (car.turnPlan?.nodeId === nearest.node.id && car.turnPlan.blockedSinceS != null) {
            return {
                distanceM: nearest.stopLineDistanceM,
                speedMps: 0,
                isSignal: true,
                nodeId: nearest.node.id,
                controllerType: nearest.controllerType,
            };
        }

        if (entersByReleaseAt(nearest.controllerType, nearest.phase)) {
            if (car.releasedNodeIds.has(nearest.node.id)) return null;
            if (nearest.controllerType === 'roundabout' && !this._roundaboutHolds(nearest.info, nearest.approach?.id)) return null;
            return {
                distanceM: nearest.stopLineDistanceM,
                speedMps: 0,
                isSignal: true,
                nodeId: nearest.node.id,
                controllerType: nearest.controllerType,
            };
        }

        if (!this._mayProceed(nearest, car)) {
            return {
                distanceM: nearest.stopLineDistanceM,
                speedMps: 0,
                isSignal: true,
                nodeId: nearest.node.id,
                controllerType: nearest.controllerType,
            };
        }
        return null;
    }

    _nearestNodeAhead(gates, car) {
        let nearest = null;
        for (const gate of gates) {
            if (gate.stopLineDistanceM <= car.distanceM) continue;
            if (!nearest || gate.stopLineDistanceM < nearest.stopLineDistanceM) nearest = gate;
        }
        return nearest;
    }

    /** Does `car` have the go at `gate` - its road's green, or the green arrow of a protected turn it is in the lane for. */
    _mayProceed(gate, car) {
        const controller = gate.info.controller;
        if (gate.phase === 0 ? controller.isArterialGreen() : controller.isCrossGreen()) return true;
        return this._turnArrowFor(gate, car);
    }

    /** Is `car` in the left-turn lane of `gate` that leaves as a slip road - it never meets the stop line, so no signal holds it. */
    _isSlipCar(gate, car) {
        if (!gate.slipJoin) return false;
        const moves = gate.slotLaneUse?.[car.lane];
        return Boolean(moves) && isTurnOnlyLane(moves, 'left');
    }

    /**
     * Released by `gate`'s protected turn stage: a car in a lane that only makes that turn while the arrow is green, and - on a
     * lone lead approach (`turnPhase.full`) - every other lane of it for the whole stage, the arrow's clearance included, since
     * its own through green carries straight on into the next stage. The rest of the road waits for its through green.
     */
    _turnArrowFor(gate, car) {
        if (this._isSlipCar(gate, car)) return true;
        const controller = gate.info.controller;
        if (!gate.turnPhase || !controller.inTurn || controller.phase !== gate.phase) return false;
        const moves = gate.slotLaneUse?.[car.lane];
        if (moves && isTurnOnlyLane(moves, gate.turnPhase.movement)) return controller.phaseState === 'green';
        if (!gate.turnPhase.full) return false;
        // A shared-lane car making the protected turn only starts it while the arrow is green - not into the clearance before the other side goes.
        return controller.phaseState === 'green' || car.turnPlan?.nodeId !== gate.node.id || car.turnPlan.movement !== gate.turnPhase.movement;
    }

    /** Resolves a single named gate (near or far linked node) to a virtual stationary obstacle if it currently blocks this car. */
    _connectorSignalAhead(gateInfo, gateDistanceM, car, approachId = null, phase = 1) {
        if (gateDistanceM <= car.distanceM) return null; // already past it, or entered past it (see _divertCarToConnector)

        if (entersByReleaseAt(gateInfo.controllerType, phase)) {
            if (car.releasedNodeIds.has(gateInfo.node.id)) return null;
            if (gateInfo.controllerType === 'roundabout' && !this._roundaboutHolds(gateInfo, approachId)) return null;
            return { distanceM: gateDistanceM, speedMps: 0, isSignal: true, nodeId: gateInfo.node.id, controllerType: gateInfo.controllerType };
        }
        if (!(phase === 0 ? gateInfo.controller.isArterialGreen() : gateInfo.controller.isCrossGreen()) && !this._turnArrowFor(this.gatesByApproachId.get(approachId) ?? {}, car)) {
            return { distanceM: gateDistanceM, speedMps: 0, isSignal: true, nodeId: gateInfo.node.id, controllerType: gateInfo.controllerType };
        }
        return null;
    }

    /**
     * Turn planning (turn lanes). The moment a node becomes the next one ahead,
     * the car picks its movement there: it turns with the connector's
     * `crossChance`, and picks uniformly among the turns the node's geometry
     * and lane use allow. _tryChangeLane() then works it into a lane that
     * allows that movement over the rest of the block.
     */
    _turnPlanFor(car, gate) {
        if (car.turnPlan?.nodeId !== gate.node.id) car.turnPlan = this._planAt(car, gate, () => this._rollTurnPlan(gate));
        return car.turnPlan;
    }

    _rollTurnPlan(gate) {
        const { node } = gate;
        const straight = { nodeId: node.id, movement: 'straight', option: null };
        const connector = node.connectorId ? this.connectorsById.get(node.connectorId) : null;
        if (!connector || (!gate.approach?.noStraight && this.rng.next() >= connector.crossChance)) return straight;

        const options = this._allowedTurnOptions(gate);
        if (!options.length) return straight;
        const option = options.length === 1 ? options[0] : options[Math.floor(this.rng.next() * options.length)];
        return { nodeId: node.id, movement: option.movement, option };
    }

    /**
     * At the stop line a car's lane decides: a car that never reached a lane
     * for its planned movement makes one its lane does allow instead -
     * straight if it can, otherwise the turn its lane is marked for (the
     * "stuck in the turn-only lane" case).
     */
    _resolvePlanAtStopLine(car, nodeId, laneUse, turnOptions, plan) {
        const laneMoves = laneUse[car.lane];
        if (laneMoves.includes(plan.movement)) return plan;
        if (car.trip) this._recordMissedTurn(car, 'wrongLane', nodeId, plan.movement);
        if (laneMoves.includes('straight')) return { nodeId, movement: 'straight', option: null };
        const option = turnOptions.find((o) => laneMoves.includes(o.movement));
        return option ? { nodeId, movement: option.movement, option } : { nodeId, movement: 'straight', option: null };
    }

    /**
     * Carries out a car's planned turn once it is right at the stop line and
     * allowed into the junction - a green, or its release at an all-way stop.
     *
     * @returns true if the car was removed from the arterial and handed off to
     * a connector lane (caller must drop it from its own array); false to
     * leave the car exactly where it is.
     */
    _maybeCrossRoute(carriageway, car) {
        const nearest = this._nearestNodeAhead(carriageway.gates, car);
        if (!nearest) return false;
        const plan = this._turnPlanFor(car, nearest);
        if (car.crossRollNodeId === nearest.node.id) return false; // already committed at this node

        const distanceToStop = nearest.stopLineDistanceM - car.distanceM;
        if (distanceToStop > CROSS_DECISION_WINDOW_M) return false;
        const mayEnter =
            entersByReleaseAt(nearest.controllerType, nearest.phase)
                ? car.releasedNodeIds.has(nearest.node.id)
                : this._mayProceed(nearest, car);
        if (!mayEnter) return false;

        car.turnPlan = this._resolvePlanAtStopLine(car, nearest.node.id, nearest.slotLaneUse, nearest.turnOptions, plan);
        const ringTarget = nearest.info.controllerType === 'roundabout' ? this._roundaboutTarget(car, nearest) : null;
        if (ringTarget) {
            if (this._driveIntoRoundabout(car, nearest, ringTarget)) return true;
            this._holdForTurn(car, nearest.node.id, false); // its way out is backed up - wait at the yield line
            return false;
        }
        if (!car.turnPlan.option) {
            car.crossRollNodeId = nearest.node.id;
            return false;
        }
        if (this._divertCarToConnector(car, nearest, car.turnPlan.option)) return true;

        // No gap on the cross street yet: wait at the stop line (see _signalAheadFor()) and retry next tick.
        this._holdForTurn(car, nearest.node.id, isThroughSlot(carriageway.laneLayout, car.lane));
        return false;
    }

    /**
     * A car whose turn is blocked holds at the stop line - for at most
     * MAX_TURN_WAIT_S, then carries straight on. One in a turn lane
     * (`canGoStraight` false) has nowhere straight to go, so it keeps waiting -
     * it only holds up the turn lane.
     */
    _holdForTurn(car, nodeId, canGoStraight = true) {
        car.turnPlan.blockedSinceS ??= this.simTimeS;
        if (canGoStraight && this.simTimeS - car.turnPlan.blockedSinceS >= MAX_TURN_WAIT_S) {
            if (car.trip) this._recordMissedTurn(car, 'blockedTurn', nodeId, car.turnPlan.movement);
            car.crossRollNodeId = nodeId;
            car.turnPlan = { nodeId, movement: 'straight', option: null };
        }
    }

    /**
     * Starts the car's turn: it leaves the arterial here and drives a curved
     * path through the junction (car.js's buildTurnPath()) into the cross-street
     * lane its turning lane pairs with (turnTargetLane()) - a single left-turn
     * lane feeds the kerb lane. It joins that lane at the far edge of the junction; until
     * then it's in `turningCars` (see _stepTurningCars()).
     */
    _divertCarToConnector(car, gate, { connectorId, dirKey, entryDistanceM, movement }) {
        const { node } = gate;
        const dir = this.connectorDirs.get(connectorId)[dirKey];
        const from = carWorldPoint(car);
        const fromHeading = roadPointAt(car.road, car.distanceM).heading;
        const direct = turnTargetLane(gate.slotLaneUse, car.lane, movement, dir.laneLayout);
        const landing = this._turnLanding(`${connectorId}:${dirKey}`, movement, {
            road: dir.road,
            lanes: this.connectorState.get(connectorId)[dirKey].lanes,
            laneIndex: direct,
            exitDistanceM: this._turnExitDistance(from, fromHeading, dir.road, direct, entryDistanceM + node.arterialRoadWidthM / 2),
            fields: { connectorId, dirKey },
            speedKph: this.connectorsById.get(connectorId).targetSpeedKph,
        });
        const { laneIndex, exitDistanceM } = landing;
        const pathKey = `${gate.carriageway?.id ?? `${gate.connector.id}:${gate.dirKey}`}@${node.id}:${connectorId}:${dirKey}:${laneIndex}`;

        // Wait at the stop line while the car ahead on the same turn is still pulling away,
        // or the cross-street lane is occupied where this turn comes out - and, turning
        // right off a two-way arterial, for a gap in the oncoming half.
        const turnAhead = this.turningCars.some((c) => c.turnPath.key === pathKey && c.distanceM < (c.lengthM + car.lengthM) / 2 + SPAWN_CLEARANCE_M);
        if (turnAhead || this._turnExitBlocked(landing.lanes, laneIndex, exitDistanceM, car.lengthM)) return false;
        const mustYield = movement === 'right' ? () => this._oncomingArterialBlocksTurn(gate) : null;
        const waitInBox = Boolean(mustYield?.());
        if (waitInBox && !this._mayWaitInBox(gate)) return false;

        const exit = lanePoint(landing.road, laneIndex, exitDistanceM);
        const path = buildTurnPath(from, fromHeading, exit.point, exit.heading);
        this.turningCars.push(
            carryTripStats(car, new Car({
                id: car.id, // the same vehicle, so the renderers keep its shape and colour
                road: landing.road,
                lane: laneIndex,
                distanceM: 0, // along the turn path until it joins the lane
                speedMps: car.speedMps,
                desiredSpeedMps: this._desiredSpeedFor(car.vehicleType, landing.speedKph / 3.6),
                colourIndex: car.colourIndex,
                startupDelayS: this.rng.next() * MAX_STARTUP_DELAY_S,
                vehicleType: car.vehicleType, // a truck turning off the arterial stays a truck
                turnPath: {
                    ...path,
                    key: pathKey,
                    ...landing.fields,
                    movement,
                    exitDistanceM,
                    speedLimitMps: turnSpeedMps(car, movement),
                    ...(waitInBox ? this._boxWait(path, gate, mustYield) : {}),
                },
            }))
        );
        return true;
    }

    /**
     * Where a turning car comes out. Normally the lane `landing` names on the
     * street it turns onto - but when that street is only a stub before it
     * widens into the next road (a join), the car turns straight into its lane
     * on the wider road: a left turn into the new kerb lane, a right turn into
     * the median lane.
     */
    _turnLanding(fromKey, movement, landing) {
        const join = this.joinsFrom.get(fromKey);
        if (!join || join.toAtM != null) return landing;
        const from = join.from.laneLayout;
        const to = join.to.laneLayout;
        if (to.mainLanes <= from.mainLanes || join.from.lengthM - landing.exitDistanceM > 15) return landing;
        const mainIndex = Math.max(0, Math.min(landing.laneIndex - from.kerbSlots, from.mainLanes - 1));
        const main = movement === 'left' ? 0 : movement === 'right' ? to.mainLanes - 1 : Math.min(mainIndex + to.mainLanes - from.mainLanes, to.mainLanes - 1);
        const [, dirKey] = join.to.key.split(':');
        return {
            road: join.to.road,
            lanes: join.to.lanes(),
            laneIndex: to.kerbSlots + main,
            exitDistanceM: Math.max(1, landing.exitDistanceM - join.from.lengthM),
            fields: join.to.kind === 'connector' ? { connectorId: join.to.connector.id, dirKey } : { carriagewayId: join.to.dir.id },
            speedKph: join.to.kind === 'connector' ? join.to.connector.targetSpeedKph : join.to.dir.arterial.targetSpeedKph,
        };
    }

    /**
     * Where along the cross-street lane a turn comes out: at least the far
     * edge of the junction, and far enough past the corner that the run out of
     * the corner matches the run into it (and MIN_TURN_LEG_M), so the curve is
     * a smooth, roughly circular sweep ending on the lane's own heading.
     */
    _turnExitDistance(from, fromHeading, road, laneIndex, junctionEdgeDistanceM) {
        const edge = lanePoint(road, laneIndex, junctionEdgeDistanceM);
        const corner = turnCorner(from, fromHeading, edge.point, edge.heading);
        const legInM = Math.hypot(corner.x - from.x, corner.y - from.y);
        const edgeBeyondCornerM = (edge.point.x - corner.x) * edge.heading.x + (edge.point.y - corner.y) * edge.heading.y;
        return junctionEdgeDistanceM + Math.max(0, Math.max(legInM, MIN_TURN_LEG_M) - edgeBeyondCornerM);
    }

    /** True if lane `laneIndex` of `lanes` (a connector direction's or an arterial's) has a vehicle too close to where a turn joins it. */
    _turnExitBlocked(lanes, laneIndex, exitDistanceM, lengthM) {
        return lanes[laneIndex].cars.some((c) => Math.abs(c.distanceM - exitDistanceM) < (c.lengthM + lengthM) / 2 + SPAWN_CLEARANCE_M);
    }

    /** The lanes a turning car is headed for - a connector direction's, or an arterial's for a car turning off a cross street. */
    _turnTargetLanes(path) {
        return path.carriagewayId ? this.carriagewayState.get(path.carriagewayId).lanes : this.connectorState.get(path.connectorId)[path.dirKey].lanes;
    }

    /**
     * Speed limit for an arterial car planning a turn at the next node: it
     * brakes comfortably so it reaches the stop line at turning speed - or, at
     * a roundabout, its yield line at roundabout speed whatever it plans there.
     */
    _turnApproachSpeedLimit(gates, car) {
        const nearest = this._nearestNodeAhead(gates, car);
        if (!nearest) return Infinity;
        const roundaboutLimit = roundaboutApproachSpeedLimit(car, nearest);
        const option = car.turnPlan?.option;
        if (!option || nearest.node.id !== car.turnPlan.nodeId) return roundaboutLimit;
        return Math.min(roundaboutLimit, turnApproachSpeedLimit(car, option.movement, nearest.stopLineDistanceM - car.distanceM));
    }

    /**
     * Cars mid-turn, one IDM step each at turning speed, following the car
     * ahead on the same turn path; a car whose cross-street lane is backed up
     * waits at the end of the junction. At the end of its path a car joins its
     * cross-street lane, carrying on with any distance it overshot.
     */
    /**
     * May a right-turner with no gap yet pull into `gate`'s junction to wait for one: only on a green ball at a signal
     * (an arrow holds the oncoming side, so there is always a gap then), and only while fewer than MAX_WAITING_IN_BOX
     * from this approach are already waiting in there.
     */
    _mayWaitInBox(gate) {
        if (!['fixed', 'greenWave', 'adaptive'].includes(gate.info.controllerType)) return false;
        const controller = gate.info.controller;
        if (!(gate.phase === 0 ? controller.isArterialGreen() : controller.isCrossGreen())) return false;
        return this.turningCars.filter((c) => c.turnPath.boxWait?.gate === gate).length < MAX_WAITING_IN_BOX;
    }

    /** The turn-path fields that make a turning car stop partway into the box until `mustYield()` clears (see _stepTurningCars()). */
    _boxWait(path, gate, mustYield) {
        return { boxWait: { gate, atM: path.lengthM * BOX_WAIT_SHARE, mustYield, sinceS: this.simTimeS } };
    }

    _stepTurningCars(dt) {
        if (!this.turningCars.length) return;
        this.turningCars.sort((a, b) => b.distanceM - a.distanceM);

        const leaderByKey = new Map();
        const stillTurning = [];
        const onRings = this._carsOnRings();
        for (const car of this.turningCars) {
            const path = car.turnPath;
            const targetLanes = this._turnTargetLanes(path);
            const exitBlocked = this._turnExitBlocked(targetLanes, car.lane, path.exitDistanceM, car.lengthM);
            const pathEnd = exitBlocked ? { distanceM: path.lengthM, speedMps: 0 } : null;
            const ringLeader = path.ringNodeId ? this._ringLeader(car, onRings.get(path.ringNodeId)) : null;
            // Waiting in the box for a gap: held short of the oncoming lanes until there is one - which the oncoming side
            // stopping for its amber/red gives at the latest. Once it goes, it is committed.
            if (path.boxWait && (!path.boxWait.mustYield() || this.simTimeS - path.boxWait.sinceS > BOX_WAIT_MAX_S)) path.boxWait = null;
            const boxHold = path.boxWait ? { distanceM: path.boxWait.atM, speedMps: 0 } : null;
            const ahead = nearestAhead(nearestAhead(nearestAhead(leaderByKey.get(path.key) ?? null, pathEnd), ringLeader), boxHold);
            stepCar(car, ahead, dt, Infinity, path.speedLimitMps);
            leaderByKey.set(path.key, car);

            if (car.distanceM < path.lengthM || exitBlocked) {
                stillTurning.push(car);
                continue;
            }
            const lane = targetLanes[car.lane];
            car.distanceM = path.exitDistanceM + (car.distanceM - path.lengthM);
            car.turnPath = null;
            /** Which way it just turned onto this road - where the road widens right after, it keeps to that side (_joinTargetSlot()). */
            car.turnedIn = { road: car.road, movement: path.movement };
            car.laneChangeCooldownS = Math.max(car.laneChangeCooldownS, TURN_EXIT_SETTLE_S);
            if (path.carriagewayId && !path.sameRoad) {
                // Joining an arterial partway along: only the stop lines still ahead count towards its per-node throughput.
                const { gates } = this.carriagewaysById.get(path.carriagewayId);
                const next = gates.findIndex((gate) => gate.stopLineDistanceM > car.distanceM);
                car.nextNodeIndex = next === -1 ? gates.length : next;
            }
            lane.cars.push(car);
            lane.cars.sort((a, b) => b.distanceM - a.distanceM);
        }
        this.turningCars = stillTurning;
    }

    /** Per roundabout, the cars going round it this tick with where they are - node id -> [{ car, angle }]. */
    _carsOnRings() {
        const byNode = new Map();
        for (const car of this.turningCars) {
            const nodeId = car.turnPath.ringNodeId;
            if (!nodeId) continue;
            const { node } = this.nodesInfo.get(nodeId);
            const p = carRenderPoint(car);
            const fromCentreM = Math.hypot(p.x - node.point.x, p.y - node.point.y);
            if (fromCentreM > node.roundabout.radiusM + 0.5) continue; // still coming in, or on its way out
            if (!byNode.has(nodeId)) byNode.set(nodeId, { node, cars: [] });
            byNode.get(nodeId).cars.push({ car, angle: Math.atan2(p.y - node.point.y, p.x - node.point.x) });
        }
        return byNode;
    }

    /**
     * The nearest car ahead of `car` round its roundabout's ring - clockwise,
     * within RING_FOLLOW_M - as a leader in `car`'s own path frame, so a car
     * that has just come in from another entry is followed, not driven through.
     */
    _ringLeader(car, ring) {
        if (!ring) return null;
        const { node, cars } = ring;
        const self = cars.find((c) => c.car === car);
        const p = carRenderPoint(car);
        const angle = self ? self.angle : Math.atan2(p.y - node.point.y, p.x - node.point.x);
        const { circulatingRadiusM } = node.roundabout;
        let best = null;
        for (const other of cars) {
            if (other.car === car) continue;
            const aheadM = ((((other.angle - angle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) * circulatingRadiusM;
            if (aheadM > RING_FOLLOW_M || (best && aheadM >= best.aheadM)) continue;
            best = { aheadM, other: other.car };
        }
        if (!best) return null;
        return { distanceM: car.distanceM + best.aheadM, speedMps: best.other.speedMps, lengthM: best.other.lengthM };
    }

    /** Stop-line detector for gap-out timing - independent of `sensorMode`, see sensors.js's detectPresenceAtStopLine(). */
    _vehicleDetectedAtStopLine(info, phase) {
        return this._phaseApproaches(info, phase).some((a) => detectPresenceAtStopLine(a.cars, a.gateDistanceM));
    }

    /** The cars in the lane(s) road `phase`'s protected turn serves, per gate with its stop-line distance - what its detectors watch. */
    _turnLaneApproaches(info, phase) {
        return (info.turnStages[phase]?.gates ?? []).map((gate) => ({
            cars: this._gateLanes(gate)
                .flatMap((lane) => lane.cars)
                .filter((car) => isTurnOnlyLane(gate.slotLaneUse?.[car.lane] ?? [], gate.turnPhase.movement)),
            gateDistanceM: gate.stopLineDistanceM,
        }));
    }

    /** Is a vehicle waiting in road `phase`'s turn lane(s), as the junction's sensors see it - what calls its turn stage. */
    _turnLaneCalled(info, phase) {
        return this._turnLaneApproaches(info, phase).some((a) => detectQueuePresence(a.cars, a.gateDistanceM, this.sensorMode));
    }

    /** Stop-line detector over road `phase`'s turn lane(s), for the turn stage's gap-out - see _vehicleDetectedAtStopLine(). */
    _turnLaneDetected(info, phase) {
        return this._turnLaneApproaches(info, phase).some((a) => detectPresenceAtStopLine(a.cars, a.gateDistanceM));
    }

    /**
     * Is the phase that would receive the next green already worth taking green away for?
     * `inductive_loop`/`magnetometer` have detection windows too short to ever count up to
     * `minCallToSwitch` real vehicles (8m/15m holds maybe 1-3 car lengths) - counting is simply
     * not a capability those sensors have, so instead of a threshold that can never trip, a call
     * just has to persist for `callDebounceS` uninterrupted seconds to count as sufficient. Wider
     * sensors (radar/camera) keep the queue-depth threshold, which they can actually see, with two
     * guards: a call held `maxCallWaitS` is served whatever its depth (a short queue isn't stranded
     * until maxGreen), and radar's count is averaged over `callDebounceS` so a single noisy +1 tick
     * can't trip the threshold early.
     */
    _isOtherCallSufficient(info, currentPhase, dt) {
        const otherPhase = 1 - currentPhase;
        const params = info.controller.params;
        info.callPersistenceS[currentPhase] = 0; // never "waiting" on itself while it holds green
        if (this.sensorMode === 'inductive_loop' || this.sensorMode === 'magnetometer') {
            const present = this._sensedQueueForApproach(info, otherPhase) > 0;
            info.callPersistenceS[otherPhase] = present ? info.callPersistenceS[otherPhase] + dt : 0;
            return info.callPersistenceS[otherPhase] >= params.callDebounceS;
        }

        const queue = this._sensedQueueForApproach(info, otherPhase);
        const present = this._phaseApproaches(info, otherPhase).some((a) => detectQueuePresence(a.cars, a.gateDistanceM, this.sensorMode));
        info.callPersistenceS[otherPhase] = present ? info.callPersistenceS[otherPhase] + dt : 0;
        if (info.callPersistenceS[otherPhase] >= params.maxCallWaitS) return true;

        if (this.sensorMode !== 'radar') return hasSufficientCall(queue, params);

        const samples = info.radarSamples[otherPhase];
        info.radarSamples[currentPhase] = [];
        samples.push({ tS: this.simTimeS, queue });
        while (samples.length && samples[0].tS <= this.simTimeS - params.callDebounceS) samples.shift();
        const windowCovered = info.callPersistenceS[otherPhase] >= params.callDebounceS;
        const meanQueue = samples.reduce((sum, s) => sum + s.queue, 0) / samples.length;
        return windowCovered && hasSufficientCall(Math.round(meanQueue), params);
    }

    /**
     * Sense whatever traffic is actually approaching this node on `phase`'s
     * road - both directions of a two-way road, summed rather than picking one,
     * since the phase serves both.
     */
    _sensedQueueForApproach(info, phase) {
        return this._phaseApproaches(info, phase).reduce(
            (sum, a) => sum + readQueueLength(a.cars, a.gateDistanceM, this.sensorMode, this.rng),
            0
        );
    }

    /** The cars on each road direction `phase` (0 the arterial, 1 the cross street) serves at `info`'s junction, with that direction's stop-line distance there. */
    _phaseApproaches(info, phase) {
        const gates = phase === 0 ? info.arterialGates : info.crossGates;
        const own = phase === 0
            ? gates.map((gate) => ({ cars: this._gateLanes(gate).flatMap((l) => l.cars), gateDistanceM: gate.stopLineDistanceM }))
            : gates.map((gate) => ({
                  cars: this.connectorState.get(gate.connector.id)[gate.dirKey].lanes.flatMap((l) => l.cars),
                  gateDistanceM: gate.stopLineDistanceM,
              }));
        // A gate right at a joined road's start queues on the road before it - in that road's frame.
        const fed = gates.flatMap((gate) => {
            const join = this.feedersByGate.get(gate);
            return join ? [{ cars: join.from.lanes().flatMap((l) => l.cars), gateDistanceM: join.from.lengthM + gate.stopLineDistanceM }] : [];
        });
        return [...own, ...fed];
    }

    /** The live lanes of the road a gate is on - an arterial direction's or a connector direction's. */
    _gateLanes(gate) {
        return gate.carriageway ? this.carriagewayState.get(gate.carriageway.id).lanes : this.connectorState.get(gate.connector.id)[gate.dirKey].lanes;
    }

    _carriagewayCars(carriageway) {
        return this.carriagewayState.get(carriageway.id).lanes.flatMap((l) => l.cars);
    }

    /** Ground-truth queue on the arterial approach(es) to `info`'s junction - both directions of a two-way arterial, summed. */
    _arterialQueueAt(info) {
        return this._phaseApproaches(info, 0).reduce((sum, a) => sum + this._countQueued(a.cars, a.gateDistanceM), 0);
    }

    _countQueued(cars, stopLineDistanceM) {
        let n = 0;
        for (const car of cars) {
            const d = stopLineDistanceM - car.distanceM;
            if (car.stoppedNow && d >= 0 && d <= QUEUE_WINDOW_M) n += 1;
        }
        return n;
    }

    /**
     * Ground-truth (never RNG-touching) read of everything the hover tooltip
     * shows - unlike `_sensedQueueForApproach()`, safe to call on every mouse
     * move without perturbing the seeded run (radar's noise draws from `rng`).
     */
    signalDebugInfo(nodeId) {
        const info = this.nodesInfo.get(nodeId);
        if (!info) return null;

        const arterialQueue = this._arterialQueueAt(info);
        const crossQueue = this._phaseApproaches(info, 1).reduce((sum, a) => sum + this._countQueued(a.cars, a.gateDistanceM), 0);

        const controller = info.controller;
        const base = { controllerType: info.controllerType, arterialQueue, crossQueue };

        if (info.controllerType === 'roundabout') {
            return {
                ...base,
                phaseLabel: 'Roundabout',
                elapsedS: null,
                etaLabel: `give way to traffic from the right already in it (a driver waiting ${ROUNDABOUT_MAX_YIELD_S}s gets the next gap)`,
            };
        }
        if (info.controllerType === 'minorStop') {
            return { ...base, phaseLabel: 'Stop street', elapsedS: null, etaLabel: 'minor road stops, then goes once no arterial vehicle is within 4 s of the junction' };
        }
        if (info.controllerType === 'allWayStop') {
            return {
                ...base,
                phaseLabel: info.node.control === 'allWayStop' ? '4-way stop' : 'Stop-controlled (load shedding)',
                elapsedS: null,
                etaLabel: 'per-approach, ~2-4.5s hesitant dwell, one side clears the box at a time',
            };
        }
        if (info.controllerType === 'none') {
            return { ...base, phaseLabel: 'Free flow', elapsedS: null, etaLabel: 'n/a' };
        }

        const phaseLabel =
            controller.phaseState === 'green'
                ? controller.inTurn
                    ? controller.phase === 0
                        ? 'Arterial turn arrow'
                        : 'Cross turn arrow'
                    : controller.phase === 0
                      ? 'Arterial green'
                      : 'Cross green'
                : controller.phaseState === 'yellow'
                  ? 'Yellow'
                  : 'All-red';

        return { ...base, phaseLabel, elapsedS: controller.phaseElapsed, etaLabel: this._signalEtaLabel(info, arterialQueue, crossQueue) };
    }

    _signalEtaLabel(info, arterialQueue, crossQueue) {
        const controller = info.controller;
        const { phase, phaseState, phaseElapsed } = controller;

        if (phaseState === 'yellow') return `${Math.max(0, YELLOW_S - phaseElapsed).toFixed(1)}s (yellow)`;
        if (phaseState === 'allRed') return `${Math.max(0, ALL_RED_S - phaseElapsed).toFixed(1)}s (all-red)`;

        if (info.controllerType === 'fixed' || info.controllerType === 'greenWave') {
            const duration = controller.inTurn ? controller.turnDurations[phase] : controller.greenDurations[phase];
            return `${Math.max(0, duration - phaseElapsed).toFixed(1)}s (fixed split)`;
        }

        if (info.controllerType === 'adaptive' && controller.inTurn) return 'turn arrow - holds while its lane keeps actuating, gaps out after';
        if (info.controllerType === 'adaptive') {
            const { minGreen, maxGreen, gapOutS, minCallToSwitch, callDebounceS, maxCallWaitS } = controller.params;
            const otherQueue = phase === 0 ? crossQueue : arterialQueue; // ground truth, for the human reading this
            const otherName = phase === 0 ? 'cross street' : 'arterial';
            const usesNarrowSensor = this.sensorMode === 'inductive_loop' || this.sensorMode === 'magnetometer';
            const gapRemaining = gapOutS - controller.secondsSinceLastDetection;

            if (phaseElapsed < minGreen) return `≥ ${(minGreen - phaseElapsed).toFixed(1)}s (holding minimum green)`;
            if (otherQueue === 0) return `resting - no call on ${otherName}`;
            if (usesNarrowSensor) {
                const persistedS = info.callPersistenceS[1 - phase];
                if (persistedS < callDebounceS)
                    return `≤ ${(maxGreen - phaseElapsed).toFixed(1)}s (call on ${otherName} too new to trust - can't count depth on this sensor, capped by max green)`;
            } else if (otherQueue < minCallToSwitch && info.callPersistenceS[1 - phase] < maxCallWaitS) {
                const capS = Math.min(maxGreen - phaseElapsed, maxCallWaitS - info.callPersistenceS[1 - phase]);
                return `≤ ${capS.toFixed(1)}s (small call on ${otherName}, served once it has waited ${maxCallWaitS}s or at max green)`;
            }
            if (gapRemaining > 0) return `extending - vehicle detected ${controller.secondsSinceLastDetection.toFixed(1)}s ago (gaps out at ${gapOutS}s)`;
            return 'ending imminently';
        }

        return 'n/a';
    }

    /**
     * Per-node throughput, distinct from `_recordClear()`'s whole-arterial
     * count: a car that crosses an intersection's stop line has cleared that
     * road section even if it later turns off the arterial at a later node
     * (or never reaches the end). `gates` is ordered along the carriageway,
     * so a car only ever needs to check its next unpassed node, not all of
     * them, and a car diverted onto a connector before reaching a stop line
     * (see `_maybeCrossRoute`) never gets counted for that node.
     */
    _recordNodeClears(state, gates, car) {
        while (car.nextNodeIndex < gates.length && car.distanceM >= gates[car.nextNodeIndex].stopLineDistanceM) {
            state.stats.clearedByNode[gates[car.nextNodeIndex].node.id] += 1;
            car.nextNodeIndex += 1;
        }
    }

    /**
     * Destination routing on or off for this run: `routingMode` from reset(),
     * else the corridor's own `routing.mode`. Off (random turning) whenever the
     * corridor has no `routing` section.
     */
    _resetRouting(seed, routingMode) {
        const mode = routingMode ?? this.layout.routing?.mode ?? 'random';
        this.routingMode = this.layout.routing && mode === 'destination' ? 'destination' : 'random';
        this.routingActive = this.routingMode === 'destination';
        this.routingStats = newRoutingStats();
        if (!this.routingActive) return;
        this.routingModel ??= buildRoutingModel(this);
        this.routingSeed = seed;
        this.arrivalRngs = new Map();
        this.tripRngs = new Map();
    }

    /** The stream a road's arrivals draw from: its own under destination routing, else the main RNG. */
    _arrivalRng(roadKey) {
        if (!this.routingActive) return this.rng;
        if (!this.arrivalRngs.has(roadKey)) this.arrivalRngs.set(roadKey, new SeededRandom((this.routingSeed ^ ARRIVAL_SEED_SALT ^ hashKey(roadKey)) >>> 0));
        return this.arrivalRngs.get(roadKey);
    }

    /** A newly spawned car's trip: its destination (by the origin's shares) and which route variant it follows there. */
    _assignTrip(car, roadKey) {
        const origin = this.routingModel.originsByRoadKey.get(roadKey);
        if (!origin?.shares.length) return;
        if (!this.tripRngs.has(roadKey)) this.tripRngs.set(roadKey, new SeededRandom((this.routingSeed ^ TRIP_SEED_SALT ^ hashKey(roadKey)) >>> 0));
        const rng = this.tripRngs.get(roadKey);
        const u = rng.next();
        const i = origin.cumulative.findIndex((c) => u < c);
        const destId = origin.shares[i === -1 ? origin.shares.length - 1 : i].destId;
        const variant = Math.floor(rng.next() * this.routingModel.od.variants.length);
        car.trip = { origin: roadKey, destId, intendedDestId: destId, variant, spawnS: this.simTimeS };
    }

    /** Where a car's route goes next from graph state `stateId` - re-aiming it at the nearest exit if its destination is out of reach. */
    _routeArc(car, stateId) {
        const { od, exitFallback, blockStates } = this.routingModel;
        // Already on the block it's heading for: no more choices, it carries on to pull off.
        if (blockStates.get(car.trip.destId)?.has(stateId)) return ON_DESTINATION_BLOCK;
        let arc = od.variants[car.trip.variant].get(car.trip.destId)?.get(stateId);
        if (!arc) {
            const fallback = exitFallback.get(stateId);
            if (!fallback || fallback === car.trip.destId) return null;
            car.trip.destId = fallback;
            this.routingStats.rerouted += 1;
            arc = od.variants[car.trip.variant].get(fallback)?.get(stateId);
        }
        return arc ?? null;
    }

    /**
     * A car's movement at `gate`: from its route when it has a trip, else the
     * random turn roll (`roll`) exactly as before routing existed.
     */
    _planAt(car, gate, roll) {
        if (!car.trip || !this.routingActive) return roll();
        const nodeId = gate.node.id;
        // A slip road leaves ahead of this junction: the route took it if its arc there is the slip, which is the left turn here.
        if (gate.slipJoin) {
            const slipState = this.routingModel.stateOfDiverge.get(gate.slipJoin);
            const slipArc = slipState && this._routeArc(car, slipState);
            if (slipArc?.kind === 'slip') {
                const option = this._allowedTurnOptions(gate).find((o) => o.movement === 'left');
                if (option) return { nodeId, movement: 'left', option };
            }
        }
        const stateId = this.routingModel.stateOfGate.get(gate);
        const arc = stateId && this._routeArc(car, stateId);
        if (arc === ON_DESTINATION_BLOCK) return { nodeId, movement: 'straight', option: null };
        if (arc?.kind !== 'move') return roll();
        if (arc.movement === 'straight') return { nodeId, movement: 'straight', option: null, preferLanes: this._lanesForNextTurn(car, gate, arc) };
        return { nodeId, movement: arc.movement, option: arc.option };
    }

    /**
     * Going straight on at `gate` along `arc`: the lanes here that also allow
     * the turn the route makes at the next junction on the same road - or null.
     */
    _lanesForNextTurn(car, gate, arc) {
        const next = this.routingModel.graph.states.get(arc.to);
        const nextGate = next?.stop?.type === 'gate' ? next.stop.gate : null;
        if (!nextGate?.approach || (nextGate.carriageway ?? nextGate.dir) !== (gate.carriageway ?? gate.dir)) return null;
        const nextArc = this._routeArc(car, arc.to);
        if (nextArc?.kind !== 'move' || nextArc.movement === 'straight') return null;
        const laneLayout = (gate.carriageway ?? gate.dir).laneLayout;
        const forTurn = laneTargets(laneLayout, nextGate.slotLaneUse, nextArc.movement, gate.centreDistanceM).target;
        const straightHere = lanesAllowing(gate.slotLaneUse, 'straight');
        const both = forTurn.filter((slot) => straightHere.includes(slot));
        return both.length ? both : null;
    }

    /** Whether a routed car's way on takes the peel-off `join`. */
    _routeTakesPeel(car, join) {
        const stateId = this.routingModel.stateOfDiverge.get(join);
        return stateId ? this._routeArc(car, stateId)?.kind === 'peel' : false;
    }

    /**
     * Cars that have reached the middle of the block they're heading for leave
     * the road there - Step 4's stand-in until cars turn into driveways.
     */
    _pullOffArrivals(roadKey, lane) {
        const { blockDirsById } = this.routingModel;
        for (let i = lane.cars.length - 1; i >= 0; i -= 1) {
            const car = lane.cars[i];
            const dir = car.trip && blockDirsById.get(car.trip.destId);
            if (!dir || dir.midpoint.roadKey !== roadKey || car.distanceM < dir.midpoint.atM) continue;
            lane.cars.splice(i, 1);
            car.trip.pulledOffAt = dir.id;
            const carriageway = this.carriagewaysById.get(roadKey);
            if (carriageway) {
                this._recordClear(carriageway.arterial, car);
            } else {
                this.accounting.totalClearedNetwork += 1;
                this._recordConnectorClear(this.connectorsById.get(roadKey.slice(0, roadKey.lastIndexOf(':'))), car);
            }
        }
    }

    /** Counts a routed car's missed movement once per car and junction, however many ticks the miss takes to play out. */
    _recordMissedTurn(car, cause, where, movement) {
        if (car.trip.missedAt === where) return;
        car.trip.missedAt = where;
        const stats = this.routingStats;
        stats.missedTurns += 1;
        stats.missedBy[cause] += 1;
        const key = `${where}:${movement}`;
        stats.missedAt[key] = (stats.missedAt[key] ?? 0) + 1;
    }

    _recordTripEnd(car) {
        const stats = this.routingStats;
        const { trip } = car;
        stats.trips += 1;
        stats.tripTimeSumS += this.simTimeS - trip.spawnS;
        if (trip.pulledOffAt) {
            stats.pulledOff += 1;
            const blockId = this.routingModel.blockDirsById.get(trip.pulledOffAt).blockId;
            stats.pulledOffByBlock[blockId] = (stats.pulledOffByBlock[blockId] ?? 0) + 1;
        } else {
            stats.toExit += 1;
        }
        const realised = trip.pulledOffAt ?? this.routingModel.exitByRoad.get(car.road) ?? null;
        if (realised !== trip.intendedDestId) stats.diverted += 1;
    }

    _recordClear(arterial, car) {
        if (car.trip) this._recordTripEnd(car);
        this.accounting.totalClearedNetwork += 1;
        this._recordVehicleClear(car);
    }

    /** Same bookkeeping as `_recordClear()`, but into the combined side-street bucket - or the arterial-connector one for a `scope: "arterial"` connector. */
    _recordConnectorClear(connector, car) {
        if (car.trip) this._recordTripEnd(car);
        this._recordVehicleClear(car);
    }

    /**
     * A vehicle leaving the network: once into the total with its whole trip, and once into every
     * scope it used, with the wait it built up there and whether it stopped there.
     */
    _recordVehicleClear(car) {
        this._addWait(car, car.road.statsKey);
        this._recordInBucket(this.totalStats, car.totalWaitS, car.everStopped);
        let arterialWaitS = 0;
        let usedArterial = false;
        let stoppedOnArterial = false;
        for (const [key, waitS] of car.waitByKey) {
            const stopped = car.stoppedKeys?.has(key) ?? false;
            this._recordInBucket(this._statsFor(key), waitS, stopped);
            if (key === 'side') continue;
            usedArterial = true;
            arterialWaitS += waitS;
            stoppedOnArterial ||= stopped;
        }
        if (usedArterial) this._recordInBucket(this.arterialScopeStats, arterialWaitS, stoppedOnArterial);
        this.allWaitTimesTotal.push(car.totalWaitS);
    }

    _recordInBucket(bucket, waitS, stopped) {
        bucket.clearedTotal += 1;
        bucket.waitSumTotal += waitS;
        if (!stopped) bucket.clearedWithoutStopTotal += 1;
        bucket.recentClears.push({ tS: this.simTimeS, waitS });
    }

    /** Each car's wait since last tick goes to the scope of the road it built up on (WAIT_ACCOUNTING). */
    _attributeWaits() {
        const attribute = (car) => this._addWait(car, car.turnPath && car.turnFromKey ? car.turnFromKey : car.road.statsKey);
        for (const state of this.carriagewayState.values()) for (const lane of state.lanes) lane.cars.forEach(attribute);
        for (const state of this.connectorState.values()) {
            for (const lane of state.fwd.lanes) lane.cars.forEach(attribute);
            for (const lane of state.rev.lanes) lane.cars.forEach(attribute);
        }
        this.turningCars.forEach(attribute);
    }

    _addWait(car, key) {
        car.waitByKey ??= new Map();
        if (!car.waitByKey.has(key)) car.waitByKey.set(key, 0);
        const deltaS = car.totalWaitS - (car.waitSeenS ?? 0);
        if (deltaS <= 0) return;
        car.waitByKey.set(key, car.waitByKey.get(key) + deltaS);
        car.stoppedKeys ??= new Set();
        car.stoppedKeys.add(key);
        car.waitSeenS = car.totalWaitS;
    }

    /**
     * Full-run, network-wide wait distribution - median/p95/max, computed once (not per
     * snapshot) from every vehicle that ever cleared, not just the last 60s rolling window
     * `snapshot()`'s avgWaitRolling uses. A single mean can't tell "everyone waits a bit
     * longer" apart from "most people are fine, a few are stranded" - this can.
     */
    waitDistributionTotal() {
        const waits = this.allWaitTimesTotal;
        if (!waits.length) return { medianWait: null, p95Wait: null, maxWait: null };

        const sorted = [...waits].sort((a, b) => a - b);
        const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        return {
            medianWait: percentile(0.5),
            p95Wait: percentile(0.95),
            maxWait: sorted[sorted.length - 1],
        };
    }

    _pruneRolling(stats) {
        const cutoff = this.simTimeS - ROLLING_WINDOW_S;
        while (stats.recentClears.length && stats.recentClears[0].tS < cutoff) {
            stats.recentClears.shift();
        }
    }

    _sampleChart(dt) {
        for (const state of this.arterialState.values()) {
            state.chartAccumS += dt;
            if (state.chartAccumS < CHART_SAMPLE_INTERVAL_S) continue;
            state.chartAccumS -= CHART_SAMPLE_INTERVAL_S;

            // Cumulative and never trimmed - unlike the rolling wait/throughput
            // stats above, "cleared over time" should show the whole run, not
            // a 60s window that would make a full-corridor traversal (which can
            // take longer than 60s) look permanently flat.
            state.chartSamples.push(state.stats.clearedTotal);
        }
    }
}
