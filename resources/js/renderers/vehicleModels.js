/**
 * vehicleModels.js - low-poly vehicle shapes for the 3D view.
 *
 * Every shape is modelled on a UNIT footprint (x: -0.5..0.5 along the direction
 * of travel, z: -0.5..0.5 across it) with heights in real metres, then scaled
 * per instance to the car's own `lengthM`/`widthM` from the snapshot. So a
 * shape is purely cosmetic: it can never make a vehicle look longer or wider
 * than the footprint the engine actually simulates.
 *
 * Each shape has three full-detail parts, each drawn as one InstancedMesh:
 *   body   - takes the per-instance colour
 *   trim   - glass and wheels, one shared dark material
 *   brake  - rear lamps, only instanced for cars that are currently stopped
 * and trucks a fourth, `accent` - the cab, with its own per-instance colour so
 * a white box or trailer can have a coloured cab (or the other way round). The
 * bus uses `accent` for the livery stripe under its windows.
 * plus `simple`, a cheaper two-tone stand-in for distant vehicles (buildSimple()).
 */
import { BoxGeometry, BufferAttribute } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { carShapeFor } from '../sim/carShapes.js';

/** Box spanning [x0,x1] x [y0,y1] x [-w/2, w/2] in unit-footprint space. */
function box(x0, x1, y0, y1, w = 1) {
    const g = new BoxGeometry(x1 - x0, y1 - y0, w);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
    return g;
}

/** Box offset sideways - `zc` is the centre across the footprint. */
function sideBox(x0, x1, y0, y1, zc, w) {
    const g = box(x0, x1, y0, y1, w);
    g.translate(0, 0, zc);
    return g;
}

function wheels(xs, radiusM = 0.34) {
    const parts = [];
    for (const x of xs) {
        for (const z of [-0.42, 0.42]) parts.push(sideBox(x - 0.07, x + 0.07, 0, radiusM * 2, z, 0.16));
    }
    return parts;
}

function brakeLamps(y0, y1) {
    return [sideBox(-0.505, -0.49, y0, y1, -0.36, 0.14), sideBox(-0.505, -0.49, y0, y1, 0.36, 0.14)];
}

const merge = (parts) => mergeGeometries(parts, false);

/**
 * Shape builders. Keys for the three truck sizes and the Ranger match car.js's
 * VEHICLE_TYPES so their shape follows the simulated type; the other passenger
 * shapes are all variants of the one simulated 'car' type (sim/carShapes.js).
 */
const BUILDERS = {
    sedan: () => ({
        body: [box(-0.5, 0.5, 0.28, 0.9, 0.98), box(-0.24, 0.18, 0.9, 1.05, 0.86)],
        glass: [box(-0.22, 0.16, 1.05, 1.42, 0.82)],
        wheels: wheels([-0.31, 0.31]),
        brake: brakeLamps(0.66, 0.8),
    }),
    hatchback: () => ({
        body: [box(-0.5, 0.5, 0.28, 0.92, 0.98), box(-0.46, 0.14, 0.92, 1.05, 0.86)],
        glass: [box(-0.44, 0.12, 1.05, 1.46, 0.82)],
        wheels: wheels([-0.32, 0.3]),
        brake: brakeLamps(0.7, 0.84),
    }),
    suv: () => ({
        body: [box(-0.5, 0.5, 0.36, 1.12, 1), box(-0.44, 0.2, 1.12, 1.24, 0.9)],
        glass: [box(-0.42, 0.18, 1.24, 1.78, 0.86)],
        wheels: wheels([-0.31, 0.31], 0.38),
        brake: brakeLamps(0.86, 1.02),
    }),
    bakkie: () => ({
        body: [
            box(-0.5, 0.5, 0.34, 0.98, 1),
            // Load-bed sides and tailgate - an open box behind the cab.
            sideBox(-0.5, -0.04, 0.98, 1.22, -0.47, 0.06),
            sideBox(-0.5, -0.04, 0.98, 1.22, 0.47, 0.06),
            box(-0.5, -0.46, 0.98, 1.22, 1),
            box(-0.02, 0.28, 0.98, 1.08, 0.9),
        ],
        glass: [box(0, 0.26, 1.08, 1.68, 0.86)],
        wheels: wheels([-0.3, 0.32], 0.37),
        brake: brakeLamps(0.8, 0.96),
    }),
    // Ford Ranger-style double cab (random events) - taller than the plain
    // bakkie, four-door cab with a sports bar and a shorter load bed.
    ranger: () => ({
        body: [
            box(-0.5, 0.5, 0.4, 1.08, 1),
            sideBox(-0.5, -0.16, 1.08, 1.32, -0.47, 0.06),
            sideBox(-0.5, -0.16, 1.08, 1.32, 0.47, 0.06),
            box(-0.5, -0.46, 1.08, 1.32, 1),
            box(-0.2, -0.16, 1.08, 1.62, 0.9),
            box(-0.14, 0.3, 1.08, 1.18, 0.92),
        ],
        glass: [box(-0.12, 0.28, 1.18, 1.86, 0.88)],
        wheels: wheels([-0.31, 0.32], 0.4),
        brake: brakeLamps(0.86, 1.06),
    }),
    // Minibus taxi (Toyota Quantum-style) - tall and boxy with a long glass band.
    taxi: () => ({
        body: [box(-0.5, 0.5, 0.3, 1.32, 1), box(-0.5, 0.42, 1.72, 2.02, 1), box(0.42, 0.5, 1.32, 1.72, 0.96)],
        glass: [box(-0.48, 0.42, 1.32, 1.72, 1.01), box(0.42, 0.51, 1.34, 1.7, 0.86)],
        wheels: wheels([-0.32, 0.34]),
        brake: brakeLamps(0.9, 1.2),
    }),
    truck_small: () => ({
        body: [box(-0.5, 0.24, 0.55, 2.85, 1)],
        accent: [box(0.26, 0.5, 0.45, 2.3, 0.96)],
        glass: [box(0.49, 0.505, 1.45, 2.15, 0.84), box(-0.5, 0.5, 0.3, 0.55, 0.6)],
        wheels: wheels([-0.3, 0.36], 0.45),
        brake: brakeLamps(0.6, 0.8),
    }),
    truck_medium: () => ({
        body: [box(-0.5, 0.28, 0.6, 3.4, 1)],
        accent: [box(0.3, 0.5, 0.5, 2.5, 0.96)],
        glass: [box(0.49, 0.505, 1.6, 2.35, 0.84), box(-0.5, 0.5, 0.35, 0.6, 0.6)],
        wheels: wheels([-0.36, -0.22, 0.38], 0.5),
        brake: brakeLamps(0.65, 0.85),
    }),
    // Articulated rig: cab, fifth-wheel gap, then a flatbed trailer with a load.
    truck_large: () => ({
        body: [box(-0.5, 0.33, 1.05, 1.3, 1), box(-0.46, 0.2, 1.3, 2.9, 0.94)],
        accent: [box(0.36, 0.5, 0.5, 2.8, 0.96)],
        glass: [box(0.49, 0.505, 1.8, 2.6, 0.84), box(0.3, 0.37, 0.6, 1.05, 0.6)],
        wheels: wheels([-0.42, -0.34, -0.26, 0.22, 0.42], 0.52),
        brake: brakeLamps(0.95, 1.2),
    }),
    // 12 m rigid city bus: a tall box with a long window band down each side, a
    // deep windscreen, the front axle under the driver and the rear axle well
    // forward of the back overhang. The accent is a livery stripe below the
    // windows - a hair wider and longer than the body so it doesn't z-fight.
    bus: () => ({
        body: [box(-0.5, 0.5, 0.35, 3.0, 1), box(-0.44, 0.4, 3.0, 3.12, 0.9)],
        accent: [box(-0.502, 0.502, 1.05, 1.3, 1.006)],
        glass: [box(-0.46, 0.45, 1.45, 2.6, 1.01), box(0.49, 0.505, 0.95, 2.7, 0.9), box(-0.505, -0.49, 1.9, 2.6, 0.8)],
        wheels: wheels([-0.2, 0.36], 0.5),
        brake: brakeLamps(0.6, 0.95),
    }),
};

export const SHAPE_KEYS = Object.keys(BUILDERS);

/**
 * Shape for one vehicle. Trucks, the bus and the Ranger follow their simulated type; the
 * BMW (random events) is a sedan in its own colour; a plain car's shape comes
 * from sim/carShapes.js.
 */
export function shapeFor(vehicleType, id) {
    if (vehicleType === 'bmw') return 'sedan';
    if (vehicleType !== 'car' && BUILDERS[vehicleType]) return vehicleType;
    return carShapeFor(id);
}

/** Bounding box of a list of parts, in unit-footprint space. */
function boundsOf(parts) {
    const geometry = merge(parts);
    geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox;
    geometry.dispose();
    return { min, max };
}

/** Tag every vertex of `part` as body (0) or trim (1) for the simple model's two-tone shader. */
function withTrimMask(part, mask) {
    const count = part.attributes.position.count;
    part.setAttribute('trimMask', new BufferAttribute(new Float32Array(count).fill(mask), 1));
    return part;
}

/**
 * Low-detail stand-in for a shape, drawn once a vehicle is only a few pixels
 * long: the real body and glass boxes, but the separate wheels folded into one
 * dark underside block. Body and trim share one mesh, told apart by the
 * `trimMask` attribute, so a simple vehicle is a single draw call per shape
 * while still reading two-tone (body colour plus dark glass and wheels).
 */
function buildSimple({ body, glass, wheels }) {
    const bodyBounds = boundsOf(body);
    const wheelBounds = boundsOf(wheels);
    const underside = box(wheelBounds.min.x, wheelBounds.max.x, 0, bodyBounds.min.y, 1);
    return merge([
        ...body.map((part) => withTrimMask(part.clone(), 0)),
        ...glass.map((part) => withTrimMask(part.clone(), 1)),
        withTrimMask(underside, 1),
    ]);
}

/** @returns {Record<string, {body: import('three').BufferGeometry, accent: import('three').BufferGeometry|null, trim: import('three').BufferGeometry, brake: import('three').BufferGeometry, simple: import('three').BufferGeometry}>} */
export function buildVehicleGeometries() {
    const out = {};
    for (const key of SHAPE_KEYS) {
        const parts = BUILDERS[key]();
        out[key] = {
            // The distant stand-in is one colour, so a truck's cab just joins its body there.
            simple: buildSimple({ ...parts, body: [...parts.body, ...(parts.accent ?? [])] }),
            body: merge(parts.body),
            accent: parts.accent ? merge(parts.accent) : null,
            trim: merge([...parts.glass, ...parts.wheels]),
            brake: merge(parts.brake),
        };
    }
    return out;
}
