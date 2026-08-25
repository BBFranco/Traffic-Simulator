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

/** How long a cross-routing turn (build step 9) takes to visually sweep from the old heading/position to the new one. */
const TURN_ANIM_DURATION_S = 1.2;

/** How long a MOBIL lane change (engine.js) takes to visually glide sideways from the old lane offset to the new one - physics/collision uses the new lane immediately, only the render position eases, same split as TURN_ANIM_DURATION_S above. */
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
        turnAnim = null,
        startupDelayS = 0,
        vehicleType = 'car',
    }) {
        this.id = nextCarId++;
        this.road = road;
        this.lane = lane;
        this.distanceM = distanceM;
        this.speedMps = speedMps;
        this.desiredSpeedMps = desiredSpeedMps;
        /** Sprite variety (build step 11) - which body colour in the renderer's palette this car uses. Ignored for trucks, which colour by size instead - see renderer.js. */
        this.colourIndex = colourIndex;

        /** 'car' | 'truck_small' | 'truck_medium' | 'truck_large' - see VEHICLE_TYPES above. */
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

        // Cross-routing bookkeeping only (build step 9): which connector-bearing
        // node id this car has already rolled the diversion dice for, so it
        // doesn't re-roll every tick while sitting in the decision window.
        this.crossRollNodeId = null;

        /** Index into this arterial's ordered node list of the next stop line this car hasn't crossed yet - see SimulationEngine#_recordNodeClears(). */
        this.nextNodeIndex = 0;

        // All-way-stop bookkeeping only (controllers/allWayStop.js, build step 6):
        // how long this car has been continuously stopped at the front of its
        // queue, and which node id (if any) the engine has released it past.
        this.stopDwellS = 0;
        this.releasedNodeId = null;

        /**
         * Cosmetic-only turn sweep (build step 9 polish): a car diverted from
         * arterial to connector changes `road`/`lane`/`distanceM` instantly for
         * physics purposes, which is correct, but rendering that raw position/
         * heading is a teleport - there's no lane geometry connecting an
         * arterial lane to a connector lane, so nothing to actually drive along.
         * Instead the RENDERED point/heading eases from where the car physically
         * was at the moment of the turn ({fromPoint, fromHeading, controlPoint},
         * captured by the caller before swapping `road` - controlPoint is the
         * intersection corner the turn bows through) to wherever the physics
         * puts it now. See carRenderPoint()/carRenderHeading() below and
         * stepCar()'s elapsedS advance.
         */
        this.turnAnim = turnAnim;
    }
}

/** Metres/radians-free lerp of a unit heading vector, renormalised - fine for the short, mostly-90-degree sweep a turn covers. */
function lerpHeading(a, b, t) {
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len };
}

const easeInOut = (t) => t * t * (3 - 2 * t);

/**
 * Where to actually draw `car` this frame - mid-sweep during a turn, otherwise
 * identical to carWorldPoint(). The sweep is a quadratic Bezier through the
 * turn's `controlPoint` (the intersection corner the car is actually turning
 * at), not a straight lerp - a straight line from an arterial's kerb lane to
 * a connector's entry lane cuts diagonally across whatever other lanes sit
 * between them, which reads as the car crossing traffic rather than turning.
 * Bowing the path through the corner keeps it visually on the intersection
 * throughout, the way an actual turn looks.
 */
export function carRenderPoint(car) {
    const target = carWorldPoint(car);
    if (!car.turnAnim) return target;

    const t = easeInOut(Math.min(1, car.turnAnim.elapsedS / TURN_ANIM_DURATION_S));
    const { fromPoint, controlPoint } = car.turnAnim;
    const u = 1 - t;
    return {
        x: u * u * fromPoint.x + 2 * u * t * controlPoint.x + t * t * target.x,
        y: u * u * fromPoint.y + 2 * u * t * controlPoint.y + t * t * target.y,
    };
}

/** Heading to draw `car` with this frame - mid-sweep during a turn, otherwise its road's own (possibly curved) heading at its current position. */
export function carRenderHeading(car) {
    const heading = roadPointAt(car.road, car.distanceM).heading;
    if (!car.turnAnim) return heading;
    const t = easeInOut(Math.min(1, car.turnAnim.elapsedS / TURN_ANIM_DURATION_S));
    return lerpHeading(car.turnAnim.fromHeading, heading, t);
}

/** Resets the id counter - call between headless batch runs so ids stay small and stable. */
export function resetCarIdCounter() {
    nextCarId = 1;
}

/** Per-lane offsets (metres) along the LEFT normal, kerb lane first - same convention as corridor.js approaches. */
export function laneOffsetsFor(roadWidthM, lanes, laneWidthM) {
    const offsets = [];
    for (let i = 0; i < lanes; i += 1) {
        offsets.push(roadWidthM / 2 - (i + 0.5) * laneWidthM);
    }
    return offsets;
}

export function carWorldPoint(car) {
    const { road } = car;
    const offsets = laneOffsetsFor(road.roadWidthM, road.lanes, road.laneWidthM);
    const { point: base, heading } = roadPointAt(road, car.distanceM);
    const normal = leftNormal(heading);

    let lateralOffsetM = offsets[car.lane];
    if (car.laneChangeAnim) {
        // Glide the RENDERED lateral offset from the old lane to the new one -
        // car.lane already switched the instant the change was decided
        // (engine.js's _tryChangeLane()), so physics/collision never waits on
        // this, only the drawn position eases sideways instead of teleporting.
        const t = easeInOut(Math.min(1, car.laneChangeAnim.elapsedS / LANE_CHANGE_ANIM_DURATION_S));
        const fromOffsetM = offsets[car.laneChangeAnim.fromLane];
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
export function carAcceleration(car, ahead) {
    const v = car.speedMps;
    const params = car.idmParams;

    if (!ahead) {
        // No leader: IDM's free-flow term only (the (sStar/s)^2 interaction term
        // vanishes as the gap goes to infinity).
        return params.a * (1 - Math.pow(v / car.desiredSpeedMps, params.delta));
    }
    const occupiedLengthM = ((ahead.lengthM ?? 0) + car.lengthM) / 2;
    const gap = Math.max(ahead.distanceM - occupiedLengthM - car.distanceM, 0.1);
    const dv = v - ahead.speedMps;
    return idmAcceleration(v, car.desiredSpeedMps, dv, gap, params);
}

/**
 * Advance one car by `dt` seconds.
 *
 * @param ahead    { distanceM, speedMps, isSignal } of whatever is in front
 *                 in this lane, or null for free flow (no leader at all).
 */
export function stepCar(car, ahead, dt) {
    const v = car.speedMps;
    let accel = carAcceleration(car, ahead);
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

    let newSpeed = v + accel * dt;
    if (newSpeed < -1e-6) {
        // Verification pass (Phase 2 spec): IDM's braking term should never push
        // velocity meaningfully below 0. A car resting exactly at its
        // equilibrium gap produces float noise on the order of 1e-9 every tick
        // (accel oscillates a hair either side of zero) - that is expected and
        // not logged. Anything past this threshold means the formula/timestep
        // is actually wrong, not that the car is reversing.
        // eslint-disable-next-line no-console
        console.warn(`[sim] car ${car.id} would go negative (${newSpeed.toFixed(3)} m/s) - clamped to 0.`);
    }
    newSpeed = Math.max(0, newSpeed);

    car.stoppedNow = newSpeed < STOPPED_SPEED_MPS;
    if (car.stoppedNow) {
        car.totalWaitS += dt;
        car.everStopped = true;
        if (ahead?.isSignal) car.stoppedForSignal = true;
    }

    car.speedMps = newSpeed;
    car.distanceM += newSpeed * dt;

    if (car.turnAnim) {
        car.turnAnim.elapsedS += dt;
        if (car.turnAnim.elapsedS >= TURN_ANIM_DURATION_S) car.turnAnim = null;
    }

    if (car.laneChangeAnim) {
        car.laneChangeAnim.elapsedS += dt;
        if (car.laneChangeAnim.elapsedS >= LANE_CHANGE_ANIM_DURATION_S) car.laneChangeAnim = null;
    }

    return car;
}
