/**
 * car.js - a single vehicle's state plus the IDM step function.
 *
 * A red signal is modelled as a virtual stationary vehicle at the stop line
 * (distanceM fixed, speedMps 0). `stepCar()` cannot tell the difference
 * between that and a real car ahead - it always calls the same
 * `equations.js:idmAcceleration()`. This is deliberate: it means "braking
 * for a red light" is never a second, hand-rolled formula.
 */
import { leftNormal, addVector, roadPointAt } from './corridor.js';
import { IDM_DEFAULTS, idmAcceleration, MOBIL_DEFAULTS } from './equations.js';

/** Speed below which a car counts as "stopped" for wait-time/queue stats. */
export const STOPPED_SPEED_MPS = 0.3;

/**
 * Physically-plausible emergency-braking bound (~0.9g), applied to IDM's raw
 * output before integrating speed - not a change to the cited formula
 * (equations.js is untouched), an engineering clamp on top of it. IDM's
 * (sStar/gap)^2 interaction term is mathematically unbounded as gap -> 0,
 * which this sim can hit for exactly one tick: a signal going yellow/red the
 * instant a car reaches the stop line makes the virtual obstacle "appear" at
 * near-zero range with no prior gradual gap-closing, something a real light's
 * dilemma-zone timing (and a real driver) would never actually present. The
 * clamp keeps that one-tick discretisation artifact from producing an
 * absurd (and stats-skewing) negative-speed swing.
 */
const MAX_DECEL_MPS2 = 9;

/** How long a MOBIL lane change (engine.js) takes to visually glide sideways from the old lane offset to the new one - physics/collision uses the new lane immediately, only the render position eases. */
const LANE_CHANGE_ANIM_DURATION_S = 0.8;

/**
 * Vehicle mix: cars plus three truck sizes. Trucks are not a second driving
 * model - they reuse the same cited IDM (equations.js) with a heavier
 * vehicle's parameters: a fully-loaded rigid/articulated truck's engine and
 * air brakes genuinely produce lower peak accel/decel than a car's, so this
 * is a parameter choice (Treiber et al.'s `a`/`b` per §2's discussion of
 * typical ranges for different vehicle classes), not an invented formula.
 * `lengthM`/`widthM` drive both the physics gap calculation (car.js/engine.js)
 * and the renderer's sprite size - one source for both.
 *
 * `a`/`b` are deliberately only mildly reduced from IDM_DEFAULTS, not
 * dramatically. IDM's desired-gap term sStar = s0 + v*T + v*dv/(2*sqrt(a*b))
 * grows sharply as a*b shrinks *while a vehicle is still closing on whatever
 * is ahead* (dv > 0) - it's what makes a car brake progressively rather than
 * slamming on at the last metre. A big a/b cut for trucks is realistic in
 * spirit (heavier vehicles need more stopping distance) but was overshooting
 * it in practice: it inflated the desired gap during every approach to a
 * queue, not just at genuine full stops, reading as "trucks leave far too
 * much space" rather than "trucks brake more gently." These values keep
 * trucks measurably heavier/slower without that runaway approach-gap effect;
 * the standstill gap itself (sStar -> s0 as v,dv -> 0) is unaffected by a/b
 * either way and stays identical to a car's.
 *
 * `mobilOverrides` makes trucks noticeably more reluctant to change lanes
 * than cars (equations.js's MOBIL model), same spirit as a real truck
 * driver's more conservative lane discipline - worse mirrors/blind spots,
 * a much longer stopping distance if they misjudge a gap, and simply more
 * to lose from a marginal manoeuvre. `changeThresholdMps2` raised means a
 * truck only bothers for a bigger acceleration payoff; `politeness` raised
 * means it weighs the cost to the vehicle it would cut in front of/pull
 * ahead of more heavily; `maxSafeDecelMps2` lowered means it demands an
 * easier (lower-forced-braking) gap in the target lane before committing.
 */
export const VEHICLE_TYPES = {
    car: { lengthM: 4.5, widthM: 1.9, desiredSpeedFactor: 1.0, idmOverrides: {}, mobilOverrides: {} },
    truck_small: {
        lengthM: 7.5,
        widthM: 2.3,
        desiredSpeedFactor: 0.93,
        idmOverrides: { a: 1.2, b: 1.9 },
        mobilOverrides: { politeness: 0.25, changeThresholdMps2: 0.4, maxSafeDecelMps2: 3.2 },
    },
    truck_medium: {
        lengthM: 10.5,
        widthM: 2.45,
        desiredSpeedFactor: 0.87,
        idmOverrides: { a: 1.0, b: 1.7 },
        mobilOverrides: { politeness: 0.3, changeThresholdMps2: 0.5, maxSafeDecelMps2: 3.0 },
    },
    truck_large: {
        lengthM: 14.5,
        widthM: 2.55,
        desiredSpeedFactor: 0.8,
        idmOverrides: { a: 0.8, b: 1.5 },
        mobilOverrides: { politeness: 0.35, changeThresholdMps2: 0.6, maxSafeDecelMps2: 2.8 },
    },
    // 12 m rigid city bus - the bus-mix slider (engine.js's setBusRatio()). Same
    // heavy-vehicle reasoning as the trucks above, pitched between the medium
    // and large truck: a full bus is heavy but geared for stop-start work.
    bus: {
        lengthM: 12,
        widthM: 2.55,
        desiredSpeedFactor: 0.85,
        idmOverrides: { a: 1.0, b: 1.7 },
        mobilOverrides: { politeness: 0.3, changeThresholdMps2: 0.5, maxSafeDecelMps2: 3.0 },
    },
    // Random-events mode only (engine.js's setRandomEvents()) - never spawned in
    // batch runs. `extraSpeedKph` is added on top of the road's target speed;
    // `laneChangeCooldownS` replaces engine.js's usual settle time between changes.
    // The BMW: 20 over, short headway, and a negative change threshold with zero
    // politeness, so it takes any safe gap - even one that gains it nothing.
    bmw: {
        lengthM: 4.8,
        widthM: 1.9,
        desiredSpeedFactor: 1.0,
        extraSpeedKph: 20,
        laneChangeCooldownS: 1.5,
        idmOverrides: { a: 2.0, T: 0.9 },
        mobilOverrides: { politeness: 0, changeThresholdMps2: -0.1, maxSafeDecelMps2: 5 },
    },
    // The Ranger double cab: sits in the fastest lane (engine.js's
    // _preferredLane()) on a tailgater's headway and standstill gap.
    ranger: {
        lengthM: 5.4,
        widthM: 1.95,
        desiredSpeedFactor: 1.0,
        extraSpeedKph: 10,
        idmOverrides: { T: 0.5, s0: 1.0 },
        mobilOverrides: { politeness: 0 },
    },
};

/** Truck size keys in small-to-large order - what the truck-mix slider rolls between and what renderer.js's truck palette is indexed by. */
export const TRUCK_VEHICLE_TYPES = ['truck_small', 'truck_medium', 'truck_large'];

let nextCarId = 1;

export class Car {
    /**
     * `road` is a plain geometry descriptor - `{ heading, startPoint, roadWidthM,
     * lanes, laneWidthM }` - not a reference to an arterial or connector object.
     * It is what makes a car generic across both: an arterial's own shape IS
     * already this shape, and a connector direction (build step 9) builds one
     * the same way for whichever half of the two-way street it represents.
     */
    constructor({
        road,
        lane,
        distanceM,
        speedMps,
        desiredSpeedMps,
        colourIndex = 0,
        turnPath = null,
        startupDelayS = 0,
        vehicleType = 'car',
        id = null,
    }) {
        /** Pass `id` to carry a vehicle's identity over when it's rebuilt - a car starting its turn (engine.js) - so it keeps its look in the renderers. */
        this.id = id ?? nextCarId++;
        this.road = road;
        this.lane = lane;
        this.distanceM = distanceM;
        this.speedMps = speedMps;
        this.desiredSpeedMps = desiredSpeedMps;
        /** Sprite variety (build step 11) - which body colour in the renderer's palette this car uses. Ignored for trucks, which colour by size instead - see renderer.js. */
        this.colourIndex = colourIndex;

        /** 'car' | 'truck_small' | 'truck_medium' | 'truck_large' | 'bus' | 'bmw' | 'ranger' - see VEHICLE_TYPES above. */
        this.vehicleType = vehicleType;
        const spec = VEHICLE_TYPES[vehicleType] ?? VEHICLE_TYPES.car;
        this.lengthM = spec.lengthM;
        this.widthM = spec.widthM;
        /** This car's own IDM parameter set (equations.js) - a heavier vehicle type overrides a/b, everything else comes from IDM_DEFAULTS. */
        this.idmParams = { ...IDM_DEFAULTS, ...spec.idmOverrides };
        /** This car's own MOBIL lane-change parameter set (equations.js) - see engine.js's _tryChangeLane(). */
        this.mobilParams = { ...MOBIL_DEFAULTS, ...spec.mobilOverrides };

        /** Seconds left before this car is allowed to evaluate another MOBIL lane change - see engine.js's _tryChangeLane(). Stops unrealistic tick-by-tick weaving. */
        this.laneChangeCooldownS = 0;
        /** Set for one tick when a vehicle alongside in the lane this car must reach blocks it - it eases off to drop in behind (engine.js's _tryMandatoryLaneChange()). */
        this.mergeDropBack = false;

        /**
         * Random-events taxis only (engine.js's _taxiPickupObstacle()): the
         * distance at which this taxi next looks for a spot to stop, and the
         * stop it's pulling over for or dwelling at - `{ atM, dwellLeftS }`,
         * where `atM` is where its front bumper stops and `dwellLeftS` is null
         * until it has actually stopped there.
         */
        this.nextPickupM = null;
        this.pickup = null;

        /**
         * Cosmetic-only sideways glide for a MOBIL lane change (engine.js),
         * same split as `turnAnim` below: `car.lane`/`car.distanceM` switch to
         * the new lane instantly for physics purposes (there's no reason to
         * delay the gap/collision logic), but rendering that raw lateral
         * offset is a sideways teleport. `{ fromLane, elapsedS }` - the lane
         * index the car was actually in when the change started - is enough
         * for carWorldPoint() to blend from that lane's offset to the new
         * one; see LANE_CHANGE_ANIM_DURATION_S above.
         */
        this.laneChangeAnim = null;

        /**
         * Driver reaction lag (seconds) before pulling away once free to move
         * again, e.g. from a red light - sampled once per car (seeded, from the
         * engine's RNG) so a whole lane of cars doesn't accelerate off a green
         * in perfect lockstep, which real drivers never do. See stepCar()'s
         * startup gate below.
         */
        this.startupDelayS = startupDelayS;
        this.startupTimerS = 0;

        this.stoppedNow = false;
        this.everStopped = false;
        this.stoppedForSignal = false;
        this.totalWaitS = 0;

        /**
         * The movement this car intends at the next intersection -
         * `{ nodeId, movement: 'left'|'straight'|'right', option }` - chosen as
         * soon as that node becomes the next one ahead, so the car has the whole
         * block to get into a lane that allows it (engine.js's turn lanes).
         */
        this.turnPlan = null;

        // Which node this car has already committed its movement at (right at
        // the stop line), so it isn't re-resolved every tick in that window.
        this.crossRollNodeId = null;

        /** Index into this arterial's ordered node list of the next stop line this car hasn't crossed yet - see SimulationEngine#_recordNodeClears(). */
        this.nextNodeIndex = 0;

        // All-way-stop bookkeeping only (controllers/allWayStop.js): the set
        // of node ids the engine has released this car past. A SET, not a
        // single id: a connector car crosses two real gates in sequence (its
        // own near node, then the far one - see engine.js's connectorDirs
        // comment), so a single scalar field would forget it had already
        // passed the near gate the instant the far gate was also evaluated
        // and released, permanently re-blocking it at the near gate forever.
        // The dwell/hesitation timer itself lives per-APPROACH on the
        // engine's own node info (engine.js#_updateAllWayStopLegClock), not
        // per-car, so every lane on one side releases together.
        this.releasedNodeIds = new Set();

        /**
         * Set while the car is driving its turn through a junction (engine.js's
         * turning pass): a curve from its arterial lane at the stop line to its
         * lane on the cross street (buildTurnPath()). While set, `distanceM` is
         * the distance travelled ALONG THAT CURVE, and `road`/`lane` are where
         * the car joins once it reaches the end.
         */
        this.turnPath = turnPath;
    }
}

const easeInOut = (t) => t * t * (3 - 2 * t);

const TURN_PATH_SAMPLES = 24;

/**
 * The curve a turning car drives through a junction: a quadratic Bezier from
 * `from` (its arterial lane at the stop line) to `to` (its cross-street lane
 * just past the junction), bowing through the corner where the two lanes'
 * centrelines meet - so the car sweeps round the corner inside the junction
 * instead of cutting across other lanes. An arc-length table lets the car be
 * placed by distance travelled, which is what its physics integrates.
 */
export function buildTurnPath(from, fromHeading, to, toHeading) {
    const corner = turnCorner(from, fromHeading, to, toHeading);
    const cumulative = [0];
    let previous = from;
    for (let i = 1; i <= TURN_PATH_SAMPLES; i += 1) {
        const point = bezierPoint(from, corner, to, i / TURN_PATH_SAMPLES);
        cumulative.push(cumulative[i - 1] + Math.hypot(point.x - previous.x, point.y - previous.y));
        previous = point;
    }
    return { from, corner, to, cumulative, lengthM: cumulative[TURN_PATH_SAMPLES] };
}

/** Where the line `from` + t*fromHeading meets the line through `to` along toHeading - the corner a turn bows through. */
export function turnCorner(from, fromHeading, to, toHeading) {
    const d = { x: to.x - from.x, y: to.y - from.y };
    const det = fromHeading.x * toHeading.y - fromHeading.y * toHeading.x;
    if (Math.abs(det) <= 1e-3) return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const t = Math.max(0, (d.x * toHeading.y - d.y * toHeading.x) / det);
    return { x: from.x + fromHeading.x * t, y: from.y + fromHeading.y * t };
}

function bezierPoint(p0, c, p2, t) {
    const u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y };
}

/** Point and heading `distanceM` along a turn path. */
export function turnPathPointAt(path, distanceM) {
    const s = Math.min(Math.max(distanceM, 0), path.lengthM);
    let i = 1;
    while (i < TURN_PATH_SAMPLES && path.cumulative[i] < s) i += 1;
    const segment = path.cumulative[i] - path.cumulative[i - 1] || 1;
    const t = (i - 1 + (s - path.cumulative[i - 1]) / segment) / TURN_PATH_SAMPLES;
    const u = 1 - t;
    const tangent = {
        x: 2 * u * (path.corner.x - path.from.x) + 2 * t * (path.to.x - path.corner.x),
        y: 2 * u * (path.corner.y - path.from.y) + 2 * t * (path.to.y - path.corner.y),
    };
    const len = Math.hypot(tangent.x, tangent.y) || 1;
    return { point: bezierPoint(path.from, path.corner, path.to, t), heading: { x: tangent.x / len, y: tangent.y / len } };
}

/** Where to draw `car` this frame: on its turn path while turning, otherwise its lane position. */
export function carRenderPoint(car) {
    return car.turnPath ? turnPathPointAt(car.turnPath, car.distanceM).point : carWorldPoint(car);
}

/** Heading to draw `car` with this frame - along its turn path while turning, otherwise its road's own (possibly curved) heading. */
export function carRenderHeading(car) {
    if (car.turnPath) return turnPathPointAt(car.turnPath, car.distanceM).heading;
    return roadPointAt(car.road, car.distanceM).heading;
}

/** Resets the id counter - call between headless batch runs so ids stay small and stable. */
export function resetCarIdCounter() {
    nextCarId = 1;
}

/**
 * Offset (metres) along the LEFT normal of lane slot `lane` on `road` - same
 * convention as corridor.js approaches. Slots run kerb first: `road.kerbSlots`
 * (0 or 1) turn-lane slots outside the kerb lane, then the road's own lanes,
 * then any median-side turn-lane slot (engine.js's lane layouts).
 */
function laneOffset(road, lane) {
    return road.roadWidthM / 2 - (lane - (road.kerbSlots ?? 0) + 0.5) * road.laneWidthM;
}

/** Centre of `lane` on `road` at `distanceM` - no lane-change glide. */
export function lanePoint(road, lane, distanceM) {
    const { point, heading } = roadPointAt(road, distanceM);
    return { point: addVector(point, leftNormal(heading), laneOffset(road, lane)), heading };
}

export function carWorldPoint(car) {
    const { road } = car;
    const { point: base, heading } = roadPointAt(road, car.distanceM);
    const normal = leftNormal(heading);

    let lateralOffsetM = laneOffset(road, car.lane);
    if (car.laneChangeAnim) {
        // Glide the RENDERED lateral offset from the old lane to the new one -
        // car.lane already switched the instant the change was decided
        // (engine.js's _tryChangeLane()), so physics/collision never waits on
        // this, only the drawn position eases sideways instead of teleporting.
        const t = easeInOut(Math.min(1, car.laneChangeAnim.elapsedS / LANE_CHANGE_ANIM_DURATION_S));
        const fromOffsetM = laneOffset(road, car.laneChangeAnim.fromLane);
        lateralOffsetM = fromOffsetM + (lateralOffsetM - fromOffsetM) * t;
    }

    return addVector(base, normal, lateralOffsetM);
}

/**
 * IDM acceleration (equations.js) `car` would have right now against `ahead`
 * - a real leading vehicle, a virtual stationary signal obstacle, or null for
 * free flow. Pure/side-effect-free, so both `stepCar()` below and engine.js's
 * MOBIL lane-change evaluation (which has to compare "what would my
 * acceleration be in this lane vs. that one" without actually moving anyone)
 * share this one formula site rather than each hand-rolling the gap maths.
 *
 * `car.distanceM`/`ahead.distanceM` are each vehicle's CENTRE along the road
 * (carWorldPoint() below draws a car centred on its `distanceM`), so the true
 * bumper-to-bumper gap is the centre-to-centre distance minus HALF of each
 * vehicle's own length - `ahead`'s half because that's how much of it sticks
 * out toward `car`, and `car`'s own half for the same reason in reverse. Both
 * halves matter once vehicles can be different lengths: crediting only the
 * leader's length (as if every vehicle were the same size) makes a car
 * following a much longer truck sit with an artificially huge gap, since the
 * truck's full length was being charged against a following car that isn't
 * that long itself. A virtual signal/stop-line obstacle has no length of its
 * own (`ahead.lengthM` is undefined), which this handles for free: only
 * `car`'s own half remains, so its FRONT bumper - not its centre - is what
 * settles near the line.
 */
export function carAcceleration(car, ahead, desiredSpeedMps = car.desiredSpeedMps) {
    const v = car.speedMps;
    const params = car.idmParams;

    if (!ahead) {
        // No leader: IDM's free-flow term only (the (sStar/s)^2 interaction term
        // vanishes as the gap goes to infinity).
        return params.a * (1 - Math.pow(v / desiredSpeedMps, params.delta));
    }
    const occupiedLengthM = ((ahead.lengthM ?? 0) + car.lengthM) / 2;
    const gap = Math.max(ahead.distanceM - occupiedLengthM - car.distanceM, 0.1);
    const dv = v - ahead.speedMps;
    return idmAcceleration(v, desiredSpeedMps, dv, gap, params);
}

/**
 * Speed a car entering the road should arrive at, given what's ahead of it in
 * its lane: its desired speed, or - when the leader is too close for that -
 * the fastest speed at which IDM's own desired gap sStar(v, dv) = s0 + v*T +
 * v*dv/(2*sqrt(a*b)) (equations.js) still fits the actual gap. Solving
 * sStar = gap with dv = v - vLeader is the quadratic
 *   k*v^2 + (T - k*vLeader)*v + (s0 - gap) = 0,  k = 1/(2*sqrt(a*b)),
 * whose positive root is taken. A car spawned at full speed onto the tail of
 * a queue backed up to the road's entry otherwise starts deep inside that
 * gap and emergency-brakes into the car ahead.
 */
export function entrySpeedBehind(car, ahead) {
    if (!ahead) return car.desiredSpeedMps;
    const { a, b, s0, T } = car.idmParams;
    const gap = ahead.distanceM - ((ahead.lengthM ?? 0) + car.lengthM) / 2 - car.distanceM;
    if (gap <= s0) return 0;
    const k = 1 / (2 * Math.sqrt(a * b));
    const linear = T - k * ahead.speedMps;
    const v = (-linear + Math.sqrt(linear * linear + 4 * k * (gap - s0))) / (2 * k);
    return Math.min(car.desiredSpeedMps, v);
}

/**
 * Advance one car by `dt` seconds.
 *
 * @param ahead    { distanceM, speedMps, isSignal } of whatever is in front
 *                 in this lane, or null for free flow (no leader at all).
 */
/**
 * `maxAccelMps2` caps IDM's output - engine.js uses it for a car easing off to
 * slot in behind a vehicle in its turn lane. `speedLimitMps` lowers IDM's
 * desired speed for this step - a car slowing for, and driving, a turn.
 */
export function stepCar(car, ahead, dt, maxAccelMps2 = Infinity, speedLimitMps = Infinity) {
    const v = car.speedMps;
    let accel = Math.min(carAcceleration(car, ahead, Math.min(car.desiredSpeedMps, speedLimitMps)), maxAccelMps2);
    accel = Math.max(accel, -MAX_DECEL_MPS2);

    // Reaction-lag gate: a stationary car that's just become free to move
    // (accel > 0) holds still until its own randomised startupDelayS has
    // elapsed, rather than pulling away the instant physics allows it. Any
    // car still genuinely blocked (accel <= 0) resets the timer, so the delay
    // is paid once per stop-then-release, not once per car for the whole run.
    const stationary = v < STOPPED_SPEED_MPS;
    if (stationary && accel > 0) {
        car.startupTimerS += dt;
        if (car.startupTimerS < car.startupDelayS) accel = 0;
    } else {
        car.startupTimerS = 0;
    }

    // IDM's braking term isn't capped at the "comfortable" b=2.0 m/s^2 (equations.js) - it
    // legitimately spikes much harder as a car closes in on a stop line, so a hard-braking car
    // routinely overshoots past 0 by a few tenths of a m/s within one dt=0.1s tick before this
    // clamps it. That's ordinary explicit-Euler discretization, not a broken formula or a car
    // reversing - it used to be logged per-occurrence, which meant thousands of warnings per
    // batch run (every car braking to a stop, every tick) drowning out actual batch progress
    // output for no diagnostic benefit.
    const newSpeed = Math.max(0, v + accel * dt);

    car.stoppedNow = newSpeed < STOPPED_SPEED_MPS;
    if (car.stoppedNow) {
        car.totalWaitS += dt;
        car.everStopped = true;
        if (ahead?.isSignal) car.stoppedForSignal = true;
    }

    car.speedMps = newSpeed;
    car.distanceM += newSpeed * dt;

    if (car.laneChangeAnim) {
        car.laneChangeAnim.elapsedS += dt;
        if (car.laneChangeAnim.elapsedS >= LANE_CHANGE_ANIM_DURATION_S) car.laneChangeAnim = null;
    }

    return car;
}
