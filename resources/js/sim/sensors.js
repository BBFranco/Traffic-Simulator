/**
 * sensors.js - one detector's observation of its approach (sensor overhaul, 2026-10-15).
 *
 * A sensor mode is modelled as what the controller is allowed to see: sensorSpecs.js declares
 * each type's zones and outputs, observeDetector() turns the engine's ground-truth cars into
 * that sensor's observation frame, and applyErrors() degrades a frame with the spec's error
 * model. Nothing here decides anything - the common demand estimator and the shared gap-out
 * rule (engine.js) read the frames without knowing which sensor produced them.
 */

/** How far upstream of the stop line `car`'s front is. */
function upstreamOf(car, stopLineDistanceM) {
    return stopLineDistanceM - car.distanceM;
}

/** Is `car` in `zone` ({ startM, lengthM } upstream of the line) under the spec's footprint rule. */
function inZone(car, stopLineDistanceM, zone, footprint) {
    const u = upstreamOf(car, stopLineDistanceM);
    if (footprint === 'body') return u <= zone.startM + zone.lengthM && u + car.lengthM >= zone.startM;
    return u <= zone.startM + zone.lengthM && u >= zone.startM;
}

/** Is `car` over an advance zone ({ centreM, lengthM }). */
function overAdvance(car, stopLineDistanceM, zone, footprint) {
    if (footprint === 'body') return inZone(car, stopLineDistanceM, { startM: zone.centreM - zone.lengthM / 2, lengthM: zone.lengthM }, 'body');
    return Math.abs(upstreamOf(car, stopLineDistanceM) - zone.centreM) <= zone.lengthM / 2;
}

/**
 * One detector's frame this tick, error-free.
 *
 * @param spec              sensorSpecs.js spec
 * @param cars              live Car[] on the approach's lane(s)
 * @param stopLineDistanceM the approach's stop line, in the cars' frame
 * @returns {{ actuated: boolean, presence: boolean, count: number|null, queueExtent: boolean|null, speedMps: number|null }}
 *   actuated    - a vehicle (moving or not) in the gap-out zone or an advance zone: feeds the shared gap-out timer.
 *   presence    - the call zone is occupied (by a standing vehicle where `call.stoppedOnly`).
 *   count       - standing vehicles in the queue zone; null when the sensor can't count.
 *   queueExtent - a standing vehicle over an advance zone; null when the sensor has none.
 *   speedMps    - mean speed of the vehicles in the queue zone (0 if none); null when the sensor doesn't measure speed.
 */
export function observeDetector(spec, cars, stopLineDistanceM) {
    const { footprint } = spec;
    let actuated = false;
    let presence = false;
    let queueExtent = false;
    let count = 0;
    let speedSum = 0;
    let speedN = 0;
    for (const car of cars) {
        if (!actuated && (inZone(car, stopLineDistanceM, spec.gapOut, footprint) || spec.advance.some((z) => overAdvance(car, stopLineDistanceM, z, footprint)))) actuated = true;
        if (!presence && (car.stoppedNow || !spec.call.stoppedOnly) && inZone(car, stopLineDistanceM, spec.call, footprint)) presence = true;
        if (!queueExtent && car.stoppedNow && spec.advance.some((z) => overAdvance(car, stopLineDistanceM, z, footprint))) queueExtent = true;
        if (spec.queue && inZone(car, stopLineDistanceM, spec.queue, footprint)) {
            if (car.stoppedNow) count += 1;
            speedSum += car.speedMps;
            speedN += 1;
        }
    }
    return {
        actuated,
        presence,
        count: spec.outputs.count ? count : null,
        queueExtent: spec.outputs.queueExtent ? queueExtent : null,
        speedMps: spec.outputs.speed ? (speedN ? speedSum / speedN : 0) : null,
    };
}

/** The frame a detector reports before it has produced its first delayed sample. */
export function emptyFrame(spec) {
    return {
        actuated: false,
        presence: false,
        count: spec.outputs.count ? 0 : null,
        queueExtent: spec.outputs.queueExtent ? false : null,
        speedMps: spec.outputs.speed ? 0 : null,
    };
}

/**
 * The spec's miss / false-call / crosstalk model on a frame (a new frame; `frame` is untouched).
 * `neighbourPresent`: another detector at the same junction sees a vehicle - what crosstalk
 * can falsely pick up. Count noise is NOT drawn here - see countWithNoise().
 */
export function applyErrors(spec, frame, rng, neighbourPresent) {
    const { missP, falseCallP, crosstalkP } = spec.errors;
    if (!missP && !falseCallP && !crosstalkP) return frame;
    const out = { ...frame };
    for (const field of ['actuated', 'presence']) {
        if (out[field]) {
            if (missP && rng.next() < missP) out[field] = false;
        } else if ((falseCallP && rng.next() < falseCallP) || (crosstalkP && neighbourPresent && rng.next() < crosstalkP)) {
            out[field] = true;
        }
    }
    return out;
}

/**
 * The count a frame reports once its noise is drawn - drawn when the count is read, never when
 * the frame is taken, so a detector nobody reads draws nothing.
 */
export function countWithNoise(spec, frame, rng, errorsOn) {
    const noise = errorsOn ? spec.errors.countNoise : null;
    if (!noise) return frame.count;
    if (noise.type === 'uniform_int') return Math.max(0, frame.count + Math.round((rng.next() - 0.5) * 2 * noise.amplitude));
    throw new Error(`Unknown count noise "${noise.type}"`);
}

export function sensorAvailable(mode, powerState, batteryBackedSensors) {
    if (powerState !== 'load_shedding') return true;
    // Cameras and radar are too power-hungry to battery-back; they always drop
    // out on a cut. Loops/magnetometers survive only if battery-backed.
    if (mode === 'camera' || mode === 'radar') return false;
    return batteryBackedSensors;
}
