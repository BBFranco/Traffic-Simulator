/**
 * car.js - a single vehicle's state plus the IDM step function.
 *
 * A red signal is modelled as a virtual stationary vehicle at the stop line
 * (distanceM fixed, speedMps 0). `stepCar()` cannot tell the difference
 * between that and a real car ahead - it always calls the same
 * `equations.js:idmAcceleration()`. This is deliberate: it means "braking
 * for a red light" is never a second, hand-rolled formula.
 */
import { leftNormal, addVector } from './corridor.js';
import { IDM_DEFAULTS, idmAcceleration } from './equations.js';

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
    }) {
        this.id = nextCarId++;
        this.road = road;
        this.lane = lane;
        this.distanceM = distanceM;
        this.speedMps = speedMps;
        this.desiredSpeedMps = desiredSpeedMps;
        /** Sprite variety (build step 11) - which body colour in the renderer's palette this car uses. */
        this.colourIndex = colourIndex;

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

/** Heading to draw `car` with this frame - mid-sweep during a turn, otherwise its road's own heading. */
export function carRenderHeading(car) {
    if (!car.turnAnim) return car.road.heading;
    const t = easeInOut(Math.min(1, car.turnAnim.elapsedS / TURN_ANIM_DURATION_S));
    return lerpHeading(car.turnAnim.fromHeading, car.road.heading, t);
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
    const normal = leftNormal(road.heading);
    const base = addVector(road.startPoint, road.heading, car.distanceM);
    return addVector(base, normal, offsets[car.lane]);
}

/**
 * Advance one car by `dt` seconds.
 *
 * @param ahead    { distanceM, speedMps, isSignal } of whatever is in front
 *                 in this lane, or null for free flow (no leader at all).
 */
export function stepCar(car, ahead, dt, carLengthM, params = IDM_DEFAULTS) {
    const v = car.speedMps;
    let accel;

    if (!ahead) {
        // No leader: IDM's free-flow term only (the (sStar/s)^2 interaction term
        // vanishes as the gap goes to infinity).
        accel = params.a * (1 - Math.pow(v / car.desiredSpeedMps, params.delta));
    } else {
        const gap = Math.max(ahead.distanceM - carLengthM - car.distanceM, 0.1);
        const dv = v - ahead.speedMps;
        accel = idmAcceleration(v, car.desiredSpeedMps, dv, gap, params);
    }
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

    return car;
}
