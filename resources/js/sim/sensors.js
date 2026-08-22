/**
 * sensors.js - build step 5.
 *
 * A sensor mode is modelled as what the controller is allowed to see (per the
 * simulator page's own description), not as hardware: this module takes the
 * engine's ground-truth queue length for an approach and degrades it to
 * whatever that sensor type would actually report.
 */

/** How far upstream of the stop line each sensor type can usefully see. */
const SENSE_WINDOW_M = {
    inductive_loop: 8, // occupancy right at the stop line only
    magnetometer: 15, // presence/count in a short zone
    radar: 60, // rough volume over a longer approach, but noisy
    camera: 120, // precise queue length over the whole visible approach
};

/**
 * @param groundTruthCars   live Car[] on this approach's lane(s), nearest-first
 * @param stopLineDistanceM distance-along-arterial of the stop line
 * @param mode               sensor mode key
 * @param rng                seeded PRNG (radar's "rough volume" adds noise)
 * @returns number - the queue length this sensor would report
 */
export function readQueueLength(groundTruthCars, stopLineDistanceM, mode, rng) {
    const windowM = SENSE_WINDOW_M[mode] ?? 0;
    const inWindow = groundTruthCars.filter(
        (c) => c.stoppedNow && stopLineDistanceM - c.distanceM <= windowM && stopLineDistanceM - c.distanceM >= 0
    );

    if (mode === 'inductive_loop') {
        // Binary occupancy - it can only say "something is there", not how much.
        return inWindow.length > 0 ? 1 : 0;
    }

    if (mode === 'radar') {
        // Rough volume: exact count blurred by +/-1 measurement noise.
        const noise = Math.round((rng.next() - 0.5) * 2);
        return Math.max(0, inWindow.length + noise);
    }

    // magnetometer and camera report an exact count within their window.
    return inWindow.length;
}

export function sensorAvailable(mode, powerState, batteryBackedSensors) {
    if (powerState !== 'load_shedding') return true;
    // Cameras and radar are too power-hungry to battery-back; they always drop
    // out on a cut. Loops/magnetometers survive only if battery-backed.
    if (mode === 'camera' || mode === 'radar') return false;
    return batteryBackedSensors;
}
