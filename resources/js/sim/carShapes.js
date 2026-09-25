/**
 * carShapes.js - which body style a plain 'car' has.
 *
 * Shared by the 3D view (renderers/vehicleModels.js), which draws it, and the
 * engine, which only needs it in random-events mode to know which cars are the
 * minibus taxis that stop to pick people up. A stable hash of the car's id, so
 * it never reads or advances the RNG and both sides always agree.
 */
export const CAR_SHAPES = ['sedan', 'hatchback', 'suv', 'bakkie', 'taxi'];

/** Cumulative weights over CAR_SHAPES (out of 100) - mostly sedans and hatchbacks, fewer taxis. */
const CAR_SHAPE_WEIGHTS = [30, 55, 75, 90, 100];

export function carShapeFor(id) {
    const bucket = (Math.imul(id | 0, 2654435761) >>> 0) % 100;
    for (let i = 0; i < CAR_SHAPE_WEIGHTS.length; i += 1) {
        if (bucket < CAR_SHAPE_WEIGHTS[i]) return CAR_SHAPES[i];
    }
    return CAR_SHAPES[0];
}
