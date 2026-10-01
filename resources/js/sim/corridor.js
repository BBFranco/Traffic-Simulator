/**
 * corridor.js - grid graph loader.
 *
 * Turns a `corridors/*.json` config into a geometry graph the renderer (and,
 * from Phase 2, the car/controller modules) can consume: world-space points in
 * metres for every arterial centreline, cross street, intersection box, stop
 * line and signal head.
 *
 * Coordinate convention: metres, x increases east, y increases SOUTH. That
 * matches canvas/screen axes so the renderer never has to flip anything.
 *
 * Road handedness is left (South Africa): for a heading `h`, the lanes carrying
 * traffic in that direction sit on the LEFT of the centreline, and the signal
 * head for that approach stands on the left kerb.
 *
 * PHASE 1 SCOPE: geometry only. This file deliberately does NOT compute green
 * wave offsets yet - see `offsetChainPlaceholder()` at the bottom for where
 * that lands in build step 14.
 */

const DIRECTION_VECTORS = {
    eastbound: { x: 1, y: 0 },
    westbound: { x: -1, y: 0 },
    northbound: { x: 0, y: -1 },
    southbound: { x: 0, y: 1 },
};

const DEFAULTS = {
    laneWidthM: 3.5,
    carLengthM: 4.5,
    crossStreetStubLengthM: 70,
    sensorMode: 'inductive_loop',
    connectorMode: 'fixed',
    handedness: 'left',
};

/** Movements a lane can be marked for at an intersection. */
export const MOVEMENTS = ['left', 'straight', 'right'];

/** Every lane-use marking, in the order the lane-arrow editor cycles through them. */
export const LANE_USE_OPTIONS = [
    ['straight'],
    ['left'],
    ['right'],
    ['left', 'straight'],
    ['straight', 'right'],
    ['left', 'right'],
    ['left', 'straight', 'right'],
];

/** A lane's movements as the corridor JSON writes them: "left", "straight_right", "all". */
export function laneUseToken(moves) {
    if (MOVEMENTS.every((m) => moves.includes(m))) return 'all';
    return MOVEMENTS.filter((m) => moves.includes(m)).join('_');
}

/** Sides of an approach a turn lane can be added on: 'left' is the kerb side (left-hand traffic), 'right' the median side. */
export const TURN_LANE_SIDES = ['left', 'right'];
export const DEFAULT_TURN_LANE_LENGTH_M = 10;
/** Drawn widening ahead of a turn lane - visual only, the lane itself is `lengthM` long. */
export const TURN_LANE_TAPER_M = 6;

/** The movements one lane of `approach` may make - `lane` is a lane index, or 'left'/'right' for a turn lane. */
export function laneMovesOf(approach, lane) {
    return typeof lane === 'string' ? approach.turnLanes[lane].laneUse : approach.laneUse[lane];
}

/** An approach's turn lanes as the corridor JSON writes them (`{ right: { lengthM, laneUse } }`), or null for none. */
export function turnLanesToConfig(turnLanes) {
    const entries = TURN_LANE_SIDES.filter((side) => turnLanes?.[side]).map((side) => [
        side,
        { lengthM: turnLanes[side].lengthM, laneUse: laneUseToken(turnLanes[side].laneUse) },
    ]);
    return entries.length ? Object.fromEntries(entries) : null;
}

/**
 * Lane use when a corridor config doesn't give one: kerb lane left + straight,
 * middle lanes straight, median lane straight + right - so turns come from the
 * side of the road they turn towards (left-hand traffic). A single-lane road
 * allows everything. `possible` drops turns the junction doesn't offer.
 */
export function defaultLaneUse(lanes, possible = MOVEMENTS) {
    const only = (moves) => moves.filter((m) => possible.includes(m));
    if (lanes <= 1) return [only(MOVEMENTS)];
    // The stem of a T-junction has no straight: kerb half turns left, median half right.
    if (!possible.includes('straight')) {
        const turns = only(['left', 'right']);
        if (turns.length === 1) return Array.from({ length: lanes }, () => [...turns]);
        return Array.from({ length: lanes }, (_, i) => (i < Math.ceil(lanes / 2) ? ['left'] : ['right']));
    }
    return Array.from({ length: lanes }, (_, i) => {
        if (i === 0) return only(['left', 'straight']);
        if (i === lanes - 1) return only(['straight', 'right']);
        return ['straight'];
    });
}

/**
 * `laneUse` on one approach: one entry per lane, KERB LANE FIRST, each a
 * movement or movements joined by "_" ("left", "straight_right", "all").
 * Parsed to arrays of MOVEMENTS; see engine.js's turn planning. An arterial
 * intersection carries its own `laneUse`; a connector carries one per linked
 * node and direction of travel - see buildApproaches().
 */
function parseLaneUse(raw, lanes, label, possible = MOVEMENTS) {
    if (raw == null) return defaultLaneUse(lanes, possible);
    if (!Array.isArray(raw) || raw.length !== lanes) {
        throw new Error(`${label}: laneUse must list exactly ${lanes} lanes (kerb lane first).`);
    }
    const parsed = raw.map((entry, i) => parseMoves(entry, `${label}: laneUse lane ${i}`));
    if (!possible.includes('straight')) {
        // At a T there's no straight on: a lane marked with it (e.g. "all") just makes its turns. Only a lane left with nothing is an error.
        const turning = parsed.map((moves) => moves.filter((m) => m !== 'straight'));
        if (turning.some((moves) => !moves.length)) {
            throw new Error(`${label}: the street ends at this junction (a T), so every lane has to turn - a lane marked straight only has nowhere to go.`);
        }
        return turning;
    }
    if (!parsed.some((moves) => moves.includes('straight'))) {
        throw new Error(`${label}: laneUse needs at least one lane that allows straight.`);
    }
    return parsed;
}

function parseMoves(entry, label) {
    const moves = entry === 'all' ? [...MOVEMENTS] : String(entry).split('_');
    const unknown = moves.filter((m) => !MOVEMENTS.includes(m));
    if (unknown.length || !moves.length) {
        throw new Error(`${label} "${entry}" - use left, straight, right, joined by "_", or "all".`);
    }
    return moves;
}

/**
 * `turnLanes` on one approach: an extra short lane added beside the stop line
 * for turning traffic - `left` on the kerb side, `right` on the median side -
 * `{ lengthM, laneUse }` each, laneUse a single token like "right". The lane
 * only exists for its last `lengthM` before the stop line (engine.js lets cars
 * into it there). On a two-way street the right one sits in the median, so the
 * median has to be at least a lane wide.
 */
function parseTurnLanes(raw, label, { oneWay, medianWidthM, laneWidthM }) {
    const turnLanes = { left: null, right: null };
    if (raw == null) return turnLanes;
    for (const [side, entry] of Object.entries(raw)) {
        if (!TURN_LANE_SIDES.includes(side)) {
            throw new Error(`${label}: turnLanes "${side}" - use left (kerb side) or right (median side).`);
        }
        if (entry == null) continue;
        const lengthM = entry.lengthM ?? DEFAULT_TURN_LANE_LENGTH_M;
        if (!(lengthM > 0)) throw new Error(`${label}: the ${side} turn lane needs a lengthM above 0, got ${entry.lengthM}.`);
        if (side === 'right' && !oneWay && medianWidthM < laneWidthM) {
            throw new Error(`${label}: a right turn lane on a two-way street sits in the median, which must be at least a lane (${laneWidthM} m) wide - it is ${medianWidthM} m.`);
        }
        const laneUse = parseMoves(entry.laneUse ?? side, `${label}: ${side} turn lane`);
        if (laneUse.includes('straight')) throw new Error(`${label}: the ${side} turn lane is for turning only - its laneUse can't include straight.`);
        turnLanes[side] = { lengthM, laneUse };
    }
    return turnLanes;
}

/** Nearest compass direction of a heading - how a connector's `laneUse` names each direction of travel. */
export function compassDirection(heading) {
    let best = null;
    let bestDot = -Infinity;
    for (const [name, v] of Object.entries(DIRECTION_VECTORS)) {
        const dot = v.x * heading.x + v.y * heading.y;
        if (dot > bestDot) {
            bestDot = dot;
            best = name;
        }
    }
    return best;
}

/* ------------------------------------------------------------------ vectors */

const add = (p, v, k = 1) => ({ x: p.x + v.x * k, y: p.y + v.y * k });
/** Right-hand normal of `h` in screen axes (y down): facing east, right is south. */
const rightNormal = (h) => ({ x: -h.y, y: h.x });
/** Left-hand normal of `h`: the kerb side for left-hand traffic. */
const leftNormal = (h) => ({ x: h.y, y: -h.x });
const negate = (h) => ({ x: -h.x, y: -h.y });

/* -------------------------------------------------------------- curves */

const CURVE_SAMPLES_PER_SEGMENT = 40;

/** Renormalised lerp of a unit heading vector. */
function lerpUnit(a, b, t) {
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len };
}

function quadPoint(seg, t) {
    const u = 1 - t;
    return {
        x: u * u * seg.p0.x + 2 * u * t * seg.c.x + t * t * seg.p1.x,
        y: u * u * seg.p0.y + 2 * u * t * seg.c.y + t * t * seg.p1.y,
    };
}

function quadTangent(seg, t) {
    const u = 1 - t;
    const x = 2 * u * (seg.c.x - seg.p0.x) + 2 * t * (seg.p1.x - seg.c.x);
    const y = 2 * u * (seg.c.y - seg.p0.y) + 2 * t * (seg.p1.y - seg.c.y);
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len };
}

/** A sampler over a dense arc-length table - shared by buildCurve() and its reversed() counterpart. */
function samplerFrom(samples) {
    const lengthM = samples[samples.length - 1].cumulativeM;

    /**
     * Position + heading at `distanceM` along the curve. Beyond [0, lengthM]
     * this extrapolates linearly along the boundary sample's own tangent
     * (straight, not a continuation of the underlying Bezier maths) - good
     * enough for an arterial's approach/exit lead-in, which only needs
     * *some* straight run-up before/after the curved section a driver would
     * actually be on, not a further bend.
     */
    function sampleAt(distanceM) {
        if (distanceM < 0) {
            const first = samples[0];
            return {
                point: { x: first.point.x + first.heading.x * distanceM, y: first.point.y + first.heading.y * distanceM },
                heading: first.heading,
            };
        }
        if (distanceM > lengthM) {
            const last = samples[samples.length - 1];
            const over = distanceM - lengthM;
            return {
                point: { x: last.point.x + last.heading.x * over, y: last.point.y + last.heading.y * over },
                heading: last.heading,
            };
        }
        const d = distanceM;
        let lo = 0;
        let hi = samples.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (samples[mid].cumulativeM < d) lo = mid + 1;
            else hi = mid;
        }
        const b = samples[lo];
        const a = samples[Math.max(0, lo - 1)];
        const span = b.cumulativeM - a.cumulativeM;
        const t = span > 1e-6 ? (d - a.cumulativeM) / span : 0;
        return {
            point: {
                x: a.point.x + (b.point.x - a.point.x) * t,
                y: a.point.y + (b.point.y - a.point.y) * t,
            },
            heading: lerpUnit(a.heading, b.heading, t),
        };
    }

    /** Arc length of the curve point nearest `point` (projected onto the sampled polyline), and how far off the curve `point` sits. */
    function nearest(point) {
        let best = { distanceM: 0, offM: Infinity };
        for (let i = 1; i < samples.length; i += 1) {
            const a = samples[i - 1];
            const b = samples[i];
            const vx = b.point.x - a.point.x;
            const vy = b.point.y - a.point.y;
            const len2 = vx * vx + vy * vy;
            const t = len2 > 0 ? Math.max(0, Math.min(1, ((point.x - a.point.x) * vx + (point.y - a.point.y) * vy) / len2)) : 0;
            const offM = Math.hypot(a.point.x + vx * t - point.x, a.point.y + vy * t - point.y);
            if (offM < best.offM) best = { distanceM: a.cumulativeM + (b.cumulativeM - a.cumulativeM) * t, offM };
        }
        return best;
    }

    return {
        lengthM,
        points: samples.map((s) => s.point),
        sampleAt,
        nearest,
        reversed: () =>
            samplerFrom(
                [...samples].reverse().map((s) => ({
                    point: s.point,
                    heading: { x: -s.heading.x, y: -s.heading.y },
                    cumulativeM: lengthM - s.cumulativeM,
                }))
            ),
    };
}

/**
 * A curve for a connector's centreline: a chain of quadratic Beziers,
 * authored as an odd-length list of alternating anchor/control world points
 * (`[P0, C1, P1, C2, P2, ...]`) - the same one-control-point sweep car.js's
 * `buildTurnPath()` uses for a junction turn, just chained so a loop ramp
 * (~180 degrees or more) is reachable with a few segments instead of one.
 * Densely sampled once at load into an arc-length table so `distanceM` along
 * a curved road means the same real driven metres it always has - see
 * `roadPointAt()` below, the one seam that lets car.js/engine.js treat a
 * curved and a straight road identically.
 */
function buildCurve(rawPoints, id) {
    if (!Array.isArray(rawPoints) || rawPoints.length < 3 || rawPoints.length % 2 === 0) {
        throw new Error(
            `Curve for "${id}" needs an odd number of points >= 3 (anchor, control, anchor, ...), got ${rawPoints?.length ?? 0}.`
        );
    }
    const pts = rawPoints.map((p) => ({ x: p.xM, y: p.yM }));
    const segments = [];
    for (let i = 0; i + 2 < pts.length; i += 2) {
        segments.push({ p0: pts[i], c: pts[i + 1], p1: pts[i + 2] });
    }

    const samples = [];
    let cumulative = 0;
    let prevPoint = null;
    for (const seg of segments) {
        for (let i = 0; i <= CURVE_SAMPLES_PER_SEGMENT; i += 1) {
            if (i === 0 && prevPoint) continue; // shared anchor with the previous segment's last sample
            const t = i / CURVE_SAMPLES_PER_SEGMENT;
            const point = quadPoint(seg, t);
            if (prevPoint) cumulative += Math.hypot(point.x - prevPoint.x, point.y - prevPoint.y);
            samples.push({ point, heading: quadTangent(seg, t), cumulativeM: cumulative });
            prevPoint = point;
        }
    }

    return samplerFrom(samples);
}

/**
 * Position + heading `distanceM` along `road` - the one seam that makes a
 * curved connector/arterial (`road.curve` set, see `buildConnector()`/
 * `buildArterial()`) and an ordinary straight road interchangeable
 * everywhere downstream (car.js, engine.js). `road.curveOffsetM` (default 0)
 * is how far the curve's OWN t=0 sits past this road's distanceM=0: for a
 * connector that's 0 (distanceM=0 is the connector's own start, same as the
 * curve's t=0), but for an arterial distanceM=0 is the approach lead-in's
 * spawn point, `approachLengthM` before the curve's own first-node t=0 - so
 * an arterial's road descriptor sets `curveOffsetM: approachLengthM` to line
 * the two up (see engine.js's arterial `road` construction). IDM/MOBIL
 * physics never touch heading, only
 * distanceM/speedMps, so this is the only place curve-vs-straight has to be
 * known at all.
 */
export function roadPointAt(road, distanceM) {
    if (road.curve) return road.curve.sampleAt(distanceM - (road.curveOffsetM ?? 0));
    return { point: add(road.startPoint, road.heading, distanceM), heading: road.heading };
}

/**
 * A `demand` block is either a flat `spawnRatePerLanePerMin`, or a
 * `spawnRatePerLanePerMinMin`/`Max` pair (+ optional `fluctuationPeriodS`)
 * for demand that oscillates over the run - see equations.js's
 * `fluctuatingDemand()`. Either way this returns a `spawnRatePerLanePerMin`
 * ("design flow"): the flat value as given, or the range's midpoint if
 * fluctuating - what fixedTime.js/greenWave.js time their one-off Webster
 * plan to, standing in for a historical traffic count. `fluctuation` is null
 * unless a range was given; when set, engine.js's `_liveSpawnRate()` uses it
 * instead of the design flow to actually draw car arrivals.
 */
/**
 * Webster's s, measured on this engine rather than taken from a textbook: its IDM cars (T = 1.5 s,
 * startup lag) discharge a deep straight-through queue at ~1250 veh/h/lane (single-intersection,
 * 30 s greens), not the 1800-1900 a real surveyed junction gives. Planning on the textbook value
 * times every signal for capacity that isn't there. Every corridor JSON uses it too.
 */
export const MODEL_SATURATION_FLOW_PER_LANE_PER_HOUR = 1250;

function buildDemand(raw, id, defaultSpawnRatePerLanePerMin) {
    const saturationFlowPerLanePerHour = raw?.saturationFlowPerLanePerHour ?? MODEL_SATURATION_FLOW_PER_LANE_PER_HOUR;
    const min = raw?.spawnRatePerLanePerMinMin;
    const max = raw?.spawnRatePerLanePerMinMax;

    if (min == null && max == null) {
        return {
            spawnRatePerLanePerMin: raw?.spawnRatePerLanePerMin ?? defaultSpawnRatePerLanePerMin,
            saturationFlowPerLanePerHour,
            fluctuation: null,
        };
    }
    if (min == null || max == null) {
        throw new Error(`"${id}"'s fluctuating demand needs both spawnRatePerLanePerMinMin and spawnRatePerLanePerMinMax.`);
    }
    if (min < 0 || max < min) {
        throw new Error(`"${id}"'s fluctuating demand range is invalid: min=${min}, max=${max}.`);
    }
    return {
        spawnRatePerLanePerMin: (min + max) / 2,
        saturationFlowPerLanePerHour,
        fluctuation: { minPerLanePerMin: min, maxPerLanePerMin: max, periodS: raw?.fluctuationPeriodS ?? 300 },
    };
}

/* ------------------------------------------------------------------- loader */

/**
 * @param {object} config parsed corridor JSON
 * @returns {object} layout graph
 */
export function buildLayout(config) {
    if (!config || !Array.isArray(config.arterials) || config.arterials.length === 0) {
        throw new Error(describeMissingArterials(config));
    }

    const defaults = { ...DEFAULTS, ...(config.defaults ?? {}) };
    const laneWidthM = defaults.laneWidthM;

    const arterials = config.arterials.map((raw) => buildArterial(raw, laneWidthM));
    const nodesById = new Map();
    for (const arterial of arterials) {
        for (const node of arterial.intersections) {
            if (nodesById.has(node.id)) {
                throw new Error(`Duplicate intersection id "${node.id}" in corridor config.`);
            }
            nodesById.set(node.id, node);
        }
    }

    const joinRefs = (config.joins ?? []).flatMap((join) => [join.from, join.to]).map((ref) => String(ref).split(':')[0]);
    const built = (config.connectors ?? []).map((raw) => buildConnector(raw, nodesById, defaults, laneWidthM, joinRefs.includes(raw.id)));
    /** Drawn-only road pieces (no junctions, no traffic, not joined to anything) - e.g. slip roads. */
    const decorations = built.filter((c) => c.decorative);
    const connectors = built.filter((c) => !c.decorative);
    const joins = parseJoins(config.joins ?? [], arterials, connectors);

    // Every intersection gets a cross street. If a connector runs through it the
    // cross street IS that connector (and the pair of nodes it links is what
    // cross-routing will use in build step 13); otherwise it is a local stub so
    // the intersection still reads - and signals - as a 4-way.
    for (const arterial of arterials) {
        for (const node of arterial.intersections) {
            resolveCrossStreet(node, arterial, connectors, joins, defaults, laneWidthM);
            node.approaches = buildApproaches(node, arterial, laneWidthM, connectors);
        }
    }
    for (const connector of connectors) checkConnectorLaneUseKeys(connector, nodesById);
    markFedApproaches(joins, connectors, nodesById);

    const layout = {
        id: config.id ?? null,
        name: config.name ?? 'Untitled corridor',
        description: config.description ?? '',
        meta: config.meta ?? {},
        defaults,
        laneWidthM,
        carLengthM: defaults.carLengthM,
        arterials,
        connectors,
        decorations,
        joins,
        /**
         * Drawn-only lane tapers - where a joined road gains or drops a kerb
         * lane, the extra lane's wedge of road surface: `[a, b, c]` world points,
         * `a`-`b` along the road edge and `c` the wide corner.
         */
        tapers: (config.tapers ?? []).map((taper, i) => {
            if (!Array.isArray(taper.points) || taper.points.length !== 3) throw new Error(`Taper ${i} needs exactly three points.`);
            return taper.points.map((p) => ({ x: p.xM, y: p.yM }));
        }),
        nodesById,
    };

    layout.bounds = computeBounds(layout);

    return layout;
}

/**
 * A config with no `arterials` is usually not a typo - it is a file written
 * against a different schema. Name the mismatch instead of saying "invalid".
 */
function describeMissingArterials(config) {
    if (!config || typeof config !== 'object') {
        return 'Corridor config is empty or not an object.';
    }

    const foreign = ['roads', 'collectors', 'ramps', 'links', 'streets'].filter((key) =>
        Array.isArray(config[key])
    );

    if (foreign.length > 0) {
        return (
            `Corridor config has no "arterials" array. It defines ${foreign.map((k) => `"${k}"`).join(', ')}` +
            `${Array.isArray(config.intersections) ? ' plus a top-level "intersections" array' : ''}, ` +
            `which is a different schema than this loader reads. Expected: "arterials" (each with an ` +
            `"origin", a "direction", and its own "intersections" chain carrying "distanceToNextM") ` +
            `plus "connectors". See corridors/hatfield-pretorius-francisbaard.json for the shape.`
        );
    }

    if (Array.isArray(config.intersections)) {
        return (
            'Corridor config defines a top-level "intersections" array, but this loader expects ' +
            'intersections nested inside each entry of "arterials".'
        );
    }

    return 'Corridor config must define at least one arterial (an "arterials" array).';
}

/** Unit heading for a compass bearing in degrees (0 north, 90 east) - screen axes, y down. */
function headingFromBearing(deg) {
    const rad = (deg * Math.PI) / 180;
    const round = (v) => (Math.abs(v) < 1e-12 ? 0 : v);
    return { x: round(Math.sin(rad)), y: round(-Math.cos(rad)) };
}

function buildArterial(raw, laneWidthM) {
    // `headingDeg` (a compass bearing) lets a street run at an angle; `direction` is the compass-only shorthand.
    const heading = raw.headingDeg != null ? headingFromBearing(raw.headingDeg) : DIRECTION_VECTORS[raw.direction];
    if (!heading) {
        throw new Error(
            `Arterial "${raw.id}" has unknown direction "${raw.direction}". ` +
                `Expected one of: ${Object.keys(DIRECTION_VECTORS).join(', ')}, or give a headingDeg.`
        );
    }
    if (!Array.isArray(raw.intersections) || raw.intersections.length === 0) {
        throw new Error(`Arterial "${raw.id}" defines no intersections.`);
    }

    const origin = { x: raw.origin?.xM ?? 0, y: raw.origin?.yM ?? 0 };
    const approachLengthM = raw.approachLengthM ?? 200;
    const exitLengthM = raw.exitLengthM ?? 200;
    const lanes = raw.lanes ?? 1;
    /**
     * A two-way arterial (`oneWay: false`) carries half its `lanes` each way,
     * like a two-way connector: its intersections are listed in `direction`
     * order, and each node's `laneUse`/`turnLanes` is keyed by the compass
     * direction of travel (`{ eastbound: [...], westbound: [...] }`).
     */
    const oneWay = raw.oneWay ?? true;
    if (!oneWay && raw.curve) {
        throw new Error(`Arterial "${raw.id}" is two-way, so it can't be curved.`);
    }
    const perSideLanes = oneWay ? lanes : Math.max(1, Math.floor(lanes / 2));
    const medianWidthM = oneWay ? 0 : raw.medianWidthM ?? 0;
    const roadWidthM = lanes * laneWidthM + medianWidthM;
    /**
     * Optional curved centreline (same odd-length alternating anchor/control
     * point format as a connector's `curve` - see buildCurve()). `direction`
     * is still required even for a curved arterial: it is this road's
     * nominal travel direction (a highway that bends still runs broadly
     * eastbound), used for `DIRECTION_VECTORS`/origin bookkeeping and as the
     * straight-line fallback when there's no curve. The curve, when given,
     * overrides *where* each node/approach actually sits - see
     * `node.arterialHeading` below, which becomes the LOCAL tangent instead
     * of this one constant `heading` once a curve is present.
     */
    const curve = raw.curve ? buildCurve(raw.curve, raw.id) : null;

    // Walk the intersection chain from the origin, accumulating distanceToNextM.
    let travelled = 0;
    const intersections = raw.intersections.map((node, index) => {
        const distanceToNextM = node.distanceToNextM ?? null;
        const at = curve ? curve.sampleAt(travelled) : { point: add(origin, heading, travelled), heading };
        const built = {
            id: node.id,
            name: node.name,
            arterialId: raw.id,
            index,
            /** metres along the arterial centreline, measured from `origin`. */
            sAlongM: travelled,
            point: at.point,
            distanceToNextM,
            distanceFromPreviousM: index === 0 ? null : raw.intersections[index - 1].distanceToNextM ?? null,
            crossStreetName: node.crossStreetName ?? null,
            crossStreetLanes: node.crossStreetLanes ?? null,
            /** Per arterial lane (kerb first), which movements that lane may make at this node - one-way arterials only; a two-way one's lives on each of its approaches (see buildApproaches()). */
            laneUse: oneWay ? parseLaneUse(node.laneUse, lanes, `Intersection "${node.id}"`) : null,
            /** A two-way arterial's `laneUse` as written in the config, keyed by compass direction - parsed in buildApproaches(). */
            rawLaneUse: oneWay ? null : rawTwoWayLaneUse(node, raw.id),
            /** The arterial approach's `turnLanes` as written in the config (keyed by compass direction on a two-way arterial) - parsed in buildApproaches(). */
            rawTurnLanes: node.turnLanes ?? null,
            /**
             * `{ arterial?, cross? }` metres to pull that road's stop lines further back than the
             * junction box edge - where the road carrying on beyond is wider than the box (a lane
             * gained right after the junction), so turning traffic can turn straight into it.
             */
            stopLineBackM: { arterial: node.stopLineBackM?.arterial ?? 0, cross: node.stopLineBackM?.cross ?? 0 },
            arterialLanes: lanes,
            arterialTwoWay: !oneWay,
            arterialMedianWidthM: medianWidthM,
            arterialRoadWidthM: roadWidthM,
            /** LOCAL tangent at this node - the curved-arterial generalisation of the old constant `heading`. Everything downstream (cross-street axis, approach/stop-line geometry, junction box orientation) reads this per node, not the arterial's own nominal `heading`. */
            arterialHeading: at.heading,
            connectorId: null,
            crossAxis: null,
            crossLanes: null,
            crossRoadWidthM: null,
            crossTwoWay: true,
            approaches: [],
        };
        travelled += distanceToNextM ?? 0;
        return built;
    });

    const last = intersections[intersections.length - 1];

    return {
        id: raw.id,
        name: raw.name,
        shortName: raw.shortName ?? raw.name,
        oneWay,
        direction: raw.direction ?? compassDirection(heading),
        heading,
        lanes,
        /** Lanes each way - all of `lanes` on a one-way arterial, half on a two-way one. */
        perSideLanes,
        medianWidthM,
        laneWidthM,
        roadWidthM,
        targetSpeedKph: raw.targetSpeedKph ?? 50,
        /** Initial controller mode from config; the UI overrides this per arterial at runtime. */
        mode: raw.mode ?? 'fixed',
        demand: buildDemand(raw.demand, raw.id, 8),
        origin,
        approachLengthM,
        exitLengthM,
        /** Set only for a curved arterial - see roadPointAt() and car.js, which read this exactly like a curved connector's `road.curve`. */
        curve,
        /** Drawn/driveable extent, including the spawn lead-in and the run-out - extrapolated past the curve's own ends (sampleAt()) when curved. */
        startPoint: curve ? curve.sampleAt(-approachLengthM).point : add(origin, heading, -approachLengthM),
        endPoint: curve ? curve.sampleAt(last.sAlongM + exitLengthM).point : add(last.point, heading, exitLengthM),
        centrelineLengthM: approachLengthM + last.sAlongM + exitLengthM,
        intersections,
    };
}

/** A two-way arterial node's `laneUse` must be keyed by direction - an array (the one-way form) would silently apply to neither. */
function rawTwoWayLaneUse(node, arterialId) {
    if (node.laneUse == null) return {};
    if (Array.isArray(node.laneUse) || typeof node.laneUse !== 'object') {
        throw new Error(
            `Intersection "${node.id}": arterial "${arterialId}" is two-way, so its laneUse is keyed by direction of travel ({ "eastbound": [...], "westbound": [...] }).`
        );
    }
    return node.laneUse;
}

/** Furthest a linked node may sit off the straight line through a connector's end nodes (m) - the config's whole-metre distances don't land exactly on it. */
const CONNECTOR_ALIGNMENT_TOLERANCE_M = 2;

function buildConnector(raw, nodesById, defaults, laneWidthM, isJoined = false) {
    const links = raw.linksArterialNodes ?? [];
    const lanes = raw.lanes ?? 2;
    const twoWay = raw.twoWay ?? true;
    /** Raised island between the two directions of a two-way street (metres); part of the carriageway width, never a lane. */
    const medianWidthM = twoWay ? raw.medianWidthM ?? 0 : 0;
    const curve = raw.curve ? buildCurve(raw.curve, raw.id) : null;

    if (links.length === 0) {
        if (!curve) throw new Error(`Connector "${raw.id}" must link at least one arterial node (or give a curve to draw it as a road piece with no junctions).`);
        // A curve through no junctions that other roads join onto carries traffic
        // (a link road, e.g. a carriageway bending to merge into another); one
        // joined to nothing is a drawn-only road piece.
        if (isJoined) {
            return {
                ...connectorTrafficFields(raw, defaults, { lanes, laneWidthM, medianWidthM, twoWay, curve }),
                nodeIds: [],
                nodeOffsetsM: [],
                nodeHeadings: [],
                heading: curve.sampleAt(0).heading,
                spanM: curve.lengthM,
                stubStartM: 0,
                stubEndM: 0,
                routeLengthM: curve.lengthM,
                startPoint: curve.points[0],
                endPoint: curve.points[curve.points.length - 1],
            };
        }
        return {
            id: raw.id,
            name: raw.name,
            decorative: true,
            lanes,
            laneWidthM,
            medianWidthM,
            roadWidthM: lanes * laneWidthM + medianWidthM,
            twoWay,
            nodeIds: [],
            curve,
            heading: curve.sampleAt(0).heading,
            startPoint: curve.points[0],
            endPoint: curve.points[curve.points.length - 1],
        };
    }
    if (new Set(links).size !== links.length) {
        throw new Error(`Connector "${raw.id}" links the same intersection more than once.`);
    }
    const linked = links.map((id) => {
        const node = nodesById.get(id);
        if (!node) {
            throw new Error(`Connector "${raw.id}" references unknown intersection "${id}".`);
        }
        return node;
    });
    // A connector through a single node (the road editor's one-junction test
    // layout) has zero span, a stub either side, running in its own compass
    // `direction`. One through several nodes runs straight from the first to
    // the last, crossing each in the order listed - or, given a `curve`, along
    // that curve, which must pass through every linked node.
    const a = linked[0];
    const b = linked[linked.length - 1];
    const singleHeading = linked.length === 1 && !curve ? DIRECTION_VECTORS[raw.direction] : null;
    if (linked.length === 1 && !curve && !singleHeading) {
        throw new Error(`Connector "${raw.id}" links one intersection, so it needs a "direction" (${Object.keys(DIRECTION_VECTORS).join(', ')}).`);
    }

    const dx = b.point.x - a.point.x;
    const dy = b.point.y - a.point.y;
    const span = Math.hypot(dx, dy);
    if (!curve && !singleHeading && span < 1) {
        throw new Error(
            `Connector "${raw.id}" links two intersections at (nearly) the same point - ` +
                `check the arterial origins and distanceToNextM chain.`
        );
    }
    const straightHeading = singleHeading ?? (span >= 1 ? { x: dx / span, y: dy / span } : null);
    const nodeOffsetsM = curve
        ? linked.map((node) => curveOffsetOf(raw.id, node, curve))
        : linked.map((node) => connectorOffsetOf(raw.id, node, a.point, straightHeading));
    nodeOffsetsM.forEach((offsetM, i) => {
        if (i > 0 && offsetM <= nodeOffsetsM[i - 1] + 1) {
            throw new Error(`Connector "${raw.id}" lists "${links[i]}" out of order - list the intersections in the order the street reaches them.`);
        }
    });
    const stub = raw.stubLengthM ?? defaults.crossStreetStubLengthM;

    const connector = {
        ...connectorTrafficFields(raw, defaults, { lanes, laneWidthM, medianWidthM, twoWay, curve }),
        /** Every linked node, in the order the street runs through them (its own heading) - one for a single-node connector. */
        nodeIds: linked.map((node) => node.id),
        /** How far along the connector (from its first linked node, or a curve's own start) each linked node sits, same order as `nodeIds`. */
        nodeOffsetsM,
    };

    if (curve) {
        // A curve's own endpoints are where the street starts/ends - its lead-ins
        // are part of the curve, so there's no separate stub either side.
        connector.heading = curve.sampleAt(0).heading;
        connector.spanM = curve.lengthM;
        connector.stubStartM = 0;
        connector.stubEndM = 0;
        connector.startPoint = curve.points[0];
        connector.endPoint = curve.points[curve.points.length - 1];
        /** The street's local heading at each linked node - its cross axis there. */
        connector.nodeHeadings = nodeOffsetsM.map((offsetM) => curve.sampleAt(offsetM).heading);
    } else {
        connector.heading = straightHeading;
        connector.spanM = span;
        // Poke past both end nodes so it reads as a through street; 0 at an end
        // makes that end node a T-junction (the street stops there).
        connector.stubStartM = raw.stubStartM ?? stub;
        connector.stubEndM = raw.stubEndM ?? stub;
        connector.startPoint = add(a.point, straightHeading, -connector.stubStartM);
        connector.endPoint = add(b.point, straightHeading, connector.stubEndM);
        connector.nodeHeadings = linked.map(() => straightHeading);
    }
    /** Stub tip to stub tip (or the whole curve) - the length each direction's cars drive. */
    connector.routeLengthM = connector.stubStartM + connector.spanM + connector.stubEndM;

    return connector;
}

/** Everything a traffic-carrying connector has regardless of its geometry. */
function connectorTrafficFields(raw, defaults, { lanes, laneWidthM, medianWidthM, twoWay, curve }) {
    return {
        id: raw.id,
        name: raw.name,
        lanes,
        laneWidthM,
        medianWidthM,
        roadWidthM: lanes * laneWidthM + medianWidthM,
        twoWay,
        crossChance: raw.crossChance ?? 0,
        /** Chance a cross-street vehicle turns onto the arterial at a junction it reaches - defaults to `crossChance`, the same "how much traffic turns here" figure the other way round. */
        turnChance: raw.turnChance ?? raw.crossChance ?? 0,
        /** "arterial" for a major road modelled as a cross street (Jan Shoba): its traffic is measured in the arterial scope, not the side streets. */
        scope: raw.scope === 'arterial' ? 'arterial' : 'sideStreet',
        /** `{ nodeId: { northbound: [...], ... } }` as written in the config - parsed per approach in buildApproaches(). */
        rawLaneUse: raw.laneUse ?? {},
        /** `{ nodeId: { northbound: { right: {...} }, ... } }` - same keys as `rawLaneUse`, parsed in buildApproaches(). */
        rawTurnLanes: raw.turnLanes ?? {},
        /** Side-street speed limit - lower than a typical arterial's when a corridor doesn't give one. */
        targetSpeedKph: raw.targetSpeedKph ?? 40,
        /** Connectors are never wave-coordinated - two-way streets have no single progression band. */
        mode: raw.mode ?? defaults.connectorMode,
        demand: buildDemand(raw.demand, raw.id, 4),
        /** Set only for a curved connector - see roadPointAt() and its reversed() counterpart for the 'rev' direction. */
        curve,
        curveReversed: curve ? curve.reversed() : null,
        /** Set by parseJoins(): another road carries on from this one's start/end, so a short stub there isn't a T. */
        joinedStart: false,
        joinedEnd: false,
    };
}

/**
 * `joins`: where one road carries straight on into another outside any
 * junction - `{ from: "<road id>:<fwd|rev>", to: "<road id>:<fwd|rev>" }`, a
 * road id being an arterial's or a connector's. Cars reaching the end of
 * `from` drive onto the start of `to` (engine.js), so traffic carries through
 * a lane-count change, a merge or a bend instead of leaving the map.
 *
 * Two partway variants, for turn roads (a lane curving off one street onto
 * another without a junction):
 *  - `toAtM`: `from`'s end merges into `to`'s kerb lane that far along `to`,
 *    giving way to traffic already on it;
 *  - `fromAtM` + `share`: that share of `from`'s traffic peels off from its
 *    kerb lane that far along it, onto the start of `to`.
 */
function parseJoins(rawJoins, arterials, connectors) {
    const parseRef = (ref, label) => {
        const [id, dirKey = 'fwd'] = String(ref).split(':');
        const arterial = arterials.find((a) => a.id === id);
        const connector = connectors.find((c) => c.id === id);
        if (!arterial && !connector) throw new Error(`Join ${label} "${ref}" names no arterial or connector.`);
        if (!['fwd', 'rev'].includes(dirKey)) throw new Error(`Join ${label} "${ref}" - the direction is fwd or rev.`);
        const oneWay = arterial ? arterial.oneWay : !connector.twoWay;
        if (dirKey === 'rev' && oneWay) throw new Error(`Join ${label} "${ref}" - that road is one-way, so it only has fwd.`);
        return { kind: arterial ? 'arterial' : 'connector', id, dirKey, key: arterial ? (dirKey === 'fwd' ? id : `${id}:rev`) : `${id}:${dirKey}`, connector };
    };
    const joins = rawJoins.map((raw, i) => {
        const join = { from: parseRef(raw.from, `${i} from`), to: parseRef(raw.to, `${i} to`), fromAtM: raw.fromAtM ?? null, toAtM: raw.toAtM ?? null, share: raw.share ?? null };
        if (join.fromAtM != null && join.toAtM != null) throw new Error(`Join ${i}: give fromAtM (peel off partway) or toAtM (merge partway), not both.`);
        if (join.fromAtM != null && !(join.share > 0 && join.share <= 1)) throw new Error(`Join ${i}: peeling off at fromAtM needs a share between 0 and 1.`);
        if (join.fromAtM != null && join.from.kind !== 'connector') throw new Error(`Join ${i}: only a connector can be peeled off partway.`);
        return join;
    });
    // One road end carries on into one road start; partway merges/peel-offs don't count against that.
    const ends = joins.filter((join) => join.fromAtM == null);
    const starts = joins.filter((join) => join.toAtM == null);
    for (const [list, key] of [[ends, 'from'], [starts, 'to']]) {
        const seen = new Set();
        for (const join of list) {
            if (seen.has(join[key].key)) throw new Error(`Two joins share the same ${key} road "${join[key].key}".`);
            seen.add(join[key].key);
        }
    }
    // A connector's fwd leaves from its end and arrives at its start; rev the other way round.
    for (const { from, to, fromAtM, toAtM } of joins) {
        if (from.connector && fromAtM == null) from.connector[from.dirKey === 'fwd' ? 'joinedEnd' : 'joinedStart'] = true;
        if (to.connector && toAtM == null) to.connector[to.dirKey === 'fwd' ? 'joinedStart' : 'joinedEnd'] = true;
    }
    return joins.map((join) => ({ ...join, from: { ...join.from, connector: undefined }, to: { ...join.to, connector: undefined } }));
}

/**
 * An approach that starts right at a join, fed by a narrower road (engine.js
 * queues that road's cars for its signal): only the lanes the narrower road
 * actually lines up with are there on the ground. Records them as
 * `approach.coveredLanes` (lane indices, kerb first) - lane arrows, the stop
 * line and the signal head cover just those, and cars handed over only take
 * them.
 */
function markFedApproaches(joins, connectors, nodesById) {
    for (const join of joins) {
        if (join.toAtM != null || join.fromAtM != null || join.to.kind !== 'connector' || join.from.kind !== 'connector') continue;
        const to = connectors.find((c) => c.id === join.to.id);
        const from = connectors.find((c) => c.id === join.from.id);
        if (!to.nodeIds.length) continue;
        const index = join.to.dirKey === 'fwd' ? 0 : to.nodeIds.length - 1;
        const node = nodesById.get(to.nodeIds[index]);
        const fwdCentreM = to.stubStartM + to.nodeOffsetsM[index];
        const upstreamM = join.to.dirKey === 'fwd' ? fwdCentreM : to.routeLengthM - fwdCentreM;
        if (upstreamM > node.arterialRoadWidthM / 2 + 6) continue;
        const approach = node.approaches.find((a) => a.kind === 'cross' && a.connectorId === to.id && a.dirKey === join.to.dirKey);
        if (!approach) continue;

        const left = leftNormal(approach.heading);
        const laneAt = (j) => add(approach.stopCentre, left, approach.laneCentreOffsets[j]);
        const covered = new Set(
            connectorEndLanePoints(from, join.from.dirKey).map((p) => {
                let best = 0;
                for (let j = 1; j < approach.lanes; j += 1) {
                    if (Math.hypot(laneAt(j).x - p.x, laneAt(j).y - p.y) < Math.hypot(laneAt(best).x - p.x, laneAt(best).y - p.y)) best = j;
                }
                return best;
            })
        );
        if (covered.size >= approach.lanes) continue;
        approach.coveredLanes = [...covered].sort((a, b) => a - b);
        const offsets = approach.coveredLanes.map((j) => approach.laneCentreOffsets[j]);
        const kerbSideM = Math.max(...offsets) + approach.laneWidthM / 2;
        const farSideM = Math.min(...offsets) - approach.laneWidthM / 2;
        approach.stopLine = { a: add(approach.stopCentre, left, kerbSideM), b: add(approach.stopCentre, left, farSideM) };
        approach.signalHead = add(add(approach.stopCentre, left, kerbSideM + 3), approach.heading, -1.5);
    }
}

/** World-space lane centres where one direction of a connector ends, kerb lane first. */
function connectorEndLanePoints(connector, dirKey) {
    const atEnd = dirKey === 'fwd';
    const sample = connector.curve
        ? connector.curve.sampleAt(atEnd ? connector.curve.lengthM : 0)
        : { point: atEnd ? connector.endPoint : connector.startPoint, heading: connector.heading };
    const heading = atEnd ? sample.heading : negate(sample.heading);
    const lanes = connector.twoWay ? Math.max(1, Math.floor(connector.lanes / 2)) : connector.lanes;
    return Array.from({ length: lanes }, (_, k) => add(sample.point, leftNormal(heading), connector.roadWidthM / 2 - (k + 0.5) * connector.laneWidthM));
}

/** Arc length along `curve` of the point nearest `node` - which has to sit on the curve, give or take the tolerance. */
function curveOffsetOf(connectorId, node, curve) {
    const { distanceM, offM } = curve.nearest(node.point);
    if (offM > CONNECTOR_ALIGNMENT_TOLERANCE_M) {
        throw new Error(`Connector "${connectorId}" is curved, but "${node.id}" sits ${offM.toFixed(1)} m off the curve - the curve has to pass through every junction it links.`);
    }
    return distanceM;
}

/** Distance of `node` along the straight line from `origin` along `heading` - it has to sit on that line, give or take the tolerance. */
function connectorOffsetOf(connectorId, node, origin, heading) {
    const dx = node.point.x - origin.x;
    const dy = node.point.y - origin.y;
    const offCentreM = Math.abs(dx * heading.y - dy * heading.x);
    if (offCentreM > CONNECTOR_ALIGNMENT_TOLERANCE_M) {
        throw new Error(
            `Connector "${connectorId}" runs straight between its first and last intersections, but "${node.id}" sits ${offCentreM.toFixed(1)} m off that line - check the arterial origins and distanceToNextM chains.`
        );
    }
    return dx * heading.x + dy * heading.y;
}

function resolveCrossStreet(node, arterial, connectors, joins, defaults, laneWidthM) {
    const through = connectors.filter((c) => c.nodeIds.includes(node.id));
    const split = through.length === 2 ? splitCrossStreet(node, through, joins) : null;
    if (through.length > 1 && !split) {
        throw new Error(
            `Intersection "${node.id}" is linked by more than one connector (${through.map((c) => c.id).join(', ')}) - a junction has one cross street, ` +
                `or two when one ends at the junction and the other starts there, joined straight through it.`
        );
    }
    const connector = split ? split.start.connector : through[0];

    if (connector) {
        node.connectorId = connector.id;
        node.crossStreetName = node.crossStreetName ?? connector.name;
        node.crossAxis = connector.nodeHeadings[connector.nodeIds.indexOf(node.id)];
        node.crossLanes = connector.lanes;
        node.crossTwoWay = connector.twoWay;
    } else {
        node.crossAxis = rightNormal(node.arterialHeading);
        node.crossLanes = node.crossStreetLanes ?? 2;
        node.crossStreetName = node.crossStreetName ?? 'Cross St';
        node.crossTwoWay = true;
        node.crossStub = {
            startPoint: add(node.point, node.crossAxis, -defaults.crossStreetStubLengthM),
            endPoint: add(node.point, node.crossAxis, defaults.crossStreetStubLengthM),
        };
    }

    node.crossMedianWidthM = connector?.medianWidthM ?? 0;
    node.crossRoadWidthM = node.crossLanes * laneWidthM + node.crossMedianWidthM;
    if (split) {
        /** Two roads meet here: each side's arm is its own road's (see splitCrossStreet()). */
        node.crossSplit = split;
        // The box is as wide as the wider of the two.
        node.crossRoadWidthM = Math.max(split.start.connector.roadWidthM, split.end.connector.roadWidthM);
    }

    // The junction footprint: as wide as the cross road along the arterial, as
    // deep as the arterial road across it.
    node.box = {
        alongArterialM: node.crossRoadWidthM,
        acrossArterialM: node.arterialRoadWidthM,
    };
}

/** How close (m) a connector's end has to be to a junction's centre to count as ending there. */
const ENDS_AT_JUNCTION_M = 1;

/**
 * A cross street that changes into another road right at a junction (Duxbury:
 * 2 + 2 north of Lynnwood, 1 + 1 south of it): one connector ends at the
 * junction's centre, the other starts there, joined straight through it. Each
 * arm is then its own road's - its lanes, width, median, arrows and turn lanes -
 * so the narrower side's stop line and turn lanes sit on the road that's there.
 *
 * `start` is the road on the side traffic comes from when running along the
 * cross axis (the ending road's own heading); `end` the road it carries on into.
 * Both run fwd along that axis. Null when the pair isn't laid out that way.
 */
function splitCrossStreet(node, pair, joins) {
    const centreOf = (c) => c.stubStartM + c.nodeOffsetsM[c.nodeIds.indexOf(node.id)];
    const ending = pair.find((c) => Math.abs(c.routeLengthM - centreOf(c)) <= ENDS_AT_JUNCTION_M);
    const starting = pair.find((c) => c !== ending && centreOf(c) <= ENDS_AT_JUNCTION_M);
    if (!ending || !starting) return null;
    const plain = joins.filter((j) => j.fromAtM == null && j.toAtM == null);
    if (!plain.some((j) => j.from.key === `${ending.id}:fwd` && j.to.key === `${starting.id}:fwd`)) {
        throw new Error(`Intersection "${node.id}": "${ending.id}" ends here and "${starting.id}" starts here - join ${ending.id}:fwd to ${starting.id}:fwd so traffic carries straight on.`);
    }
    if (ending.twoWay && starting.twoWay && !plain.some((j) => j.from.key === `${starting.id}:rev` && j.to.key === `${ending.id}:rev`)) {
        throw new Error(`Intersection "${node.id}": join ${starting.id}:rev to ${ending.id}:rev so traffic carries straight on the other way too.`);
    }
    return { start: { connector: ending }, end: { connector: starting } };
}

/**
 * The cross street's arm a cross approach arrives on, by its index (0 runs
 * along the cross axis, 1 against it): the road and its direction of travel,
 * and whether that arm has road to approach from and to carry straight on into.
 */
export function crossArm(node, connector, i) {
    const split = node.crossSplit;
    if (!split) {
        const arms = connector ? crossArms(connector, node) : null;
        return { connector, dirKey: i === 0 ? 'fwd' : 'rev', hasUpstream: !arms || arms[i].hasUpstream, hasDownstream: !arms || arms[i].hasDownstream };
    }
    // Along the axis traffic arrives on the start side's road and leaves on the end side's; against it the other way round.
    const [from, into] = i === 0 ? [split.start.connector, split.end.connector] : [split.end.connector, split.start.connector];
    const dirKey = i === 0 ? 'fwd' : 'rev';
    return { connector: from, dirKey, hasUpstream: dirKey === 'fwd' || from.twoWay, hasDownstream: dirKey === 'fwd' || into.twoWay };
}

/**
 * One approach per incoming direction: the arterial's one or two directions
 * (a one-way arterial's lanes all approach together) plus the cross street's
 * one or two directions.
 */
function buildApproaches(node, arterial, laneWidthM, connectors) {
    const approaches = [];
    const connector = connectors.find((c) => c.id === node.connectorId) ?? null;

    if (arterial.oneWay) {
        const arterialApproach = makeApproach({
            id: `${node.id}:${arterial.id}`,
            kind: 'arterial',
            label: arterial.shortName,
            node,
            heading: node.arterialHeading,
            lanes: arterial.lanes,
            roadWidthM: arterial.roadWidthM,
            // Stop line sits at the edge of the junction box, half a cross-road back.
            setbackM: node.crossRoadWidthM / 2 + node.stopLineBackM.arterial,
            oneWay: true,
            laneWidthM,
            turnLanes: parseTurnLanes(node.rawTurnLanes, `Intersection "${node.id}"`, { oneWay: true, medianWidthM: 0, laneWidthM }),
        });
        /** Per lane (kerb first), the movements it may make - the same array as `node.laneUse`, so an edit to one is an edit to both. */
        arterialApproach.laneUse = node.laneUse;
        /** Where this approach's lane use lives in the corridor JSON - 'arterial' (the node's own) or a compass direction (a two-way arterial's, or a connector's). */
        arterialApproach.laneUseKey = 'arterial';
        /** Which direction of the arterial this is - 'fwd' runs its own `direction`, 'rev' the opposite way (two-way only). */
        arterialApproach.dirKey = 'fwd';
        approaches.push(arterialApproach);
    } else {
        [node.arterialHeading, negate(node.arterialHeading)].forEach((heading, i) => {
            const laneUseKey = compassDirection(heading);
            const label = `Intersection "${node.id}" ${laneUseKey}`;
            const approach = makeApproach({
                id: i === 0 ? `${node.id}:${arterial.id}` : `${node.id}:${arterial.id}:rev`,
                kind: 'arterial',
                label: arterial.shortName,
                node,
                heading,
                lanes: arterial.perSideLanes,
                roadWidthM: arterial.roadWidthM,
                medianWidthM: arterial.medianWidthM,
                setbackM: node.crossRoadWidthM / 2 + node.stopLineBackM.arterial,
                oneWay: false,
                laneWidthM,
                turnLanes: parseTurnLanes(node.rawTurnLanes?.[laneUseKey], label, { oneWay: false, medianWidthM: arterial.medianWidthM, laneWidthM }),
            });
            approach.laneUse = parseLaneUse(node.rawLaneUse[laneUseKey], arterial.perSideLanes, label);
            approach.laneUseKey = laneUseKey;
            approach.dirKey = i === 0 ? 'fwd' : 'rev';
            approaches.push(approach);
        });
        checkTwoWayArterialKeys(node, approaches.map((a) => a.laneUseKey));
    }

    const crossHeadings = node.crossTwoWay || node.crossSplit
        ? [node.crossAxis, negate(node.crossAxis)]
        : [node.crossAxis];

    crossHeadings.forEach((heading, i) => {
        // The road this approach arrives on - the node's own cross street, or at a split junction that side's road.
        const arm = crossArm(node, connector, i);
        const road = arm.connector;
        // At a T the street stops here: nothing approaches from the missing arm,
        // and whatever approaches from the other side can only turn.
        if (!arm.hasUpstream) return;
        const noStraight = !arm.hasDownstream;
        const laneUseKey = compassDirection(heading);
        const twoWay = road ? road.twoWay : node.crossTwoWay;
        const lanes = road ? road.lanes : node.crossLanes;
        const medianWidthM = road ? road.medianWidthM : node.crossMedianWidthM;
        const approach = makeApproach({
            id: `${node.id}:cross:${i}`,
            kind: 'cross',
            label: node.crossStreetName,
            node,
            heading,
            lanes: twoWay ? Math.max(1, Math.floor(lanes / 2)) : lanes,
            roadWidthM: road ? road.roadWidthM : node.crossRoadWidthM,
            medianWidthM,
            setbackM: node.arterialRoadWidthM / 2 + node.stopLineBackM.cross,
            oneWay: !twoWay,
            laneWidthM,
            // A local stub carries no traffic, so it has no turn lanes either.
            turnLanes: parseTurnLanes(road?.rawTurnLanes[node.id]?.[laneUseKey], `Connector "${road?.id}" at "${node.id}" ${laneUseKey}`, {
                oneWay: !twoWay,
                medianWidthM,
                laneWidthM,
            }),
        });
        // Only a real cross street (a connector) carries traffic - a local stub
        // has no lanes to mark. crossAxis is the connector's own heading, so the
        // first cross approach is its 'fwd' direction and the second its 'rev' -
        // at a split junction each on its own side's road.
        if (road) {
            const connector = road;
            approach.connectorId = connector.id;
            approach.dirKey = arm.dirKey;
            approach.laneUseKey = laneUseKey;
            /** The street ends past this junction (a T) - every lane has to turn. */
            approach.noStraight = noStraight;
            // Onto a one-way arterial a cross approach can only turn one way (y points south: a positive cross product is a right turn).
            const possible = arterial.oneWay ? ['straight', heading.x * node.arterialHeading.y - heading.y * node.arterialHeading.x > 0 ? 'right' : 'left'] : MOVEMENTS;
            approach.laneUse = parseLaneUse(
                connector.rawLaneUse[node.id]?.[approach.laneUseKey],
                approach.lanes,
                `Connector "${connector.id}" at "${node.id}" ${approach.laneUseKey}`,
                noStraight ? possible.filter((m) => m !== 'straight') : possible
            );
        }
        approaches.push(approach);
    });

    return approaches;
}

/**
 * How much street `connector` has either side of `node`, per direction of travel
 * ([fwd, rev]): an arm shorter than the junction box itself isn't there, which is
 * what makes the node a T. `hasUpstream` - there's road to approach from;
 * `hasDownstream` - there's road to carry on into.
 */
export function crossArms(connector, node) {
    const fwdCentreM = connector.stubStartM + connector.nodeOffsetsM[connector.nodeIds.indexOf(node.id)];
    const minArmM = node.arterialRoadWidthM / 2 + 1;
    // A short stub another road carries on from is a lane-count change, not a T.
    const before = fwdCentreM > minArmM || connector.joinedStart;
    const after = connector.routeLengthM - fwdCentreM > minArmM || connector.joinedEnd;
    return [
        { hasUpstream: before, hasDownstream: after },
        { hasUpstream: after, hasDownstream: before },
    ];
}

/** A two-way arterial node's `laneUse`/`turnLanes` key that matches neither direction is a typo - name it rather than silently ignore it. */
function checkTwoWayArterialKeys(node, keys) {
    for (const [field, byDirection] of [['laneUse', node.rawLaneUse], ['turnLanes', node.rawTurnLanes]]) {
        for (const key of Object.keys(byDirection ?? {})) {
            if (!keys.includes(key)) {
                throw new Error(`Intersection "${node.id}": ${field} has "${key}" - traffic there runs ${keys.join(' / ')}.`);
            }
        }
    }
}

/** A connector `laneUse`/`turnLanes` entry that matches no approach is a typo - name it rather than silently ignore it. */
function checkConnectorLaneUseKeys(connector, nodesById) {
    for (const [field, byNode] of [['laneUse', connector.rawLaneUse], ['turnLanes', connector.rawTurnLanes]]) {
        for (const [nodeId, byDirection] of Object.entries(byNode)) {
            if (!connector.nodeIds.includes(nodeId)) {
                throw new Error(`Connector "${connector.id}": ${field} names "${nodeId}", which it doesn't link (links ${connector.nodeIds.join(', ')}).`);
            }
            const keys = nodesById
                .get(nodeId)
                .approaches.filter((a) => a.kind === 'cross' && a.connectorId === connector.id)
                .map((a) => a.laneUseKey);
            for (const key of Object.keys(byDirection ?? {})) {
                if (!keys.includes(key)) {
                    throw new Error(`Connector "${connector.id}": ${field} at "${nodeId}" has "${key}" - traffic there runs ${keys.join(' / ')}.`);
                }
            }
        }
    }
}

function makeApproach({ id, kind, label, node, heading, lanes, roadWidthM, medianWidthM = 0, setbackM, oneWay, laneWidthM, turnLanes }) {
    const left = leftNormal(heading);

    // Stop-line centre: `setbackM` upstream of the junction centre.
    const stopCentre = add(node.point, heading, -setbackM);

    // A one-way road's approach spans the whole carriageway. On a two-way road
    // only the left half approaches (left-hand traffic). Offsets along the left
    // normal: the kerb edge, and the edge on the median/right side - each
    // pushed out a lane where a turn lane is added on that side.
    const kerbEdgeM = roadWidthM / 2 + (turnLanes.left ? laneWidthM : 0);
    const medianEdgeM = (oneWay ? -roadWidthM / 2 : medianWidthM / 2) - (turnLanes.right ? laneWidthM : 0);
    const stopLine = oneWay
        ? { a: add(stopCentre, left, kerbEdgeM), b: add(stopCentre, left, medianEdgeM) }
        : { a: add(stopCentre, left, medianEdgeM), b: add(stopCentre, left, kerbEdgeM) };

    // Each turn lane's centre, same left-normal convention as laneCentreOffsets - just outside the kerb lane, or just past the median-side lane.
    if (turnLanes.left) turnLanes.left.centreOffsetM = kerbEdgeM - laneWidthM / 2;
    if (turnLanes.right) turnLanes.right.centreOffsetM = medianEdgeM + laneWidthM / 2;

    // Lane centres, indexed from the kerb (left) inwards. The approach's outer
    // edge is the left kerb at +roadWidth/2 in both the one-way case (lanes fill
    // the whole carriageway) and the two-way case (lanes fill the left half), so
    // one formula covers both.
    const laneCentreOffsets = [];
    for (let i = 0; i < lanes; i += 1) {
        laneCentreOffsets.push(roadWidthM / 2 - (i + 0.5) * laneWidthM);
    }

    return {
        id,
        kind,
        label,
        nodeId: node.id,
        heading,
        lanes,
        roadWidthM,
        setbackM,
        stopLine,
        stopCentre,
        /** Offsets along the LEFT normal from the road centreline, per lane. */
        laneCentreOffsets,
        laneWidthM,
        /** `{ left, right }`, each null or `{ lengthM, laneUse, centreOffsetM }` - see parseTurnLanes(). */
        turnLanes,
        /** Signal head stands on the left kerb, level with the stop line. */
        signalHead: add(add(stopCentre, left, kerbEdgeM + 3), heading, -1.5),
    };
}

/* ------------------------------------------------------------------- bounds */

function computeBounds(layout) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const include = (p, pad = 0) => {
        minX = Math.min(minX, p.x - pad);
        minY = Math.min(minY, p.y - pad);
        maxX = Math.max(maxX, p.x + pad);
        maxY = Math.max(maxY, p.y + pad);
    };

    for (const arterial of layout.arterials) {
        const pad = arterial.roadWidthM / 2;
        include(arterial.startPoint, pad);
        include(arterial.endPoint, pad);
        if (arterial.curve) {
            for (const p of arterial.curve.points) include(p, pad);
        }
        for (const node of arterial.intersections) {
            include(node.point, Math.max(node.crossRoadWidthM, node.arterialRoadWidthM));
            if (node.crossStub) {
                include(node.crossStub.startPoint, node.crossRoadWidthM / 2);
                include(node.crossStub.endPoint, node.crossRoadWidthM / 2);
            }
        }
    }

    for (const connector of layout.connectors) {
        const pad = connector.roadWidthM / 2;
        if (connector.curve) {
            // A bulging loop ramp can swing well outside the straight line
            // between its two endpoints - pad every sample point, not just
            // the ends, so the initial camera fit never clips it.
            for (const p of connector.curve.points) include(p, pad);
        } else {
            include(connector.startPoint, pad);
            include(connector.endPoint, pad);
        }
    }

    for (const piece of layout.decorations) {
        for (const p of piece.curve.points) include(p, piece.roadWidthM / 2);
    }

    return { minX, minY, maxX, maxY, widthM: maxX - minX, heightM: maxY - minY };
}

/* ---------------------------------------------------------------- Phase 2 -- */

/**
 * PLACEHOLDER for build step 14 (green wave, section 5 of the spec).
 *
 * The offset chain is per arterial and one-directional:
 *   offset_i = offset_(i-1) + distanceToNextM_(i-1) / targetSpeed_mps
 * Every ingredient is already on the layout (`intersection.distanceToNextM`,
 * `arterial.targetSpeedKph`), but computing it here in Phase 1 would be
 * controller logic arriving early - the whole point of the shell-first split.
 * Left as a named stub so step 14 has an obvious home.
 */
export function offsetChainPlaceholder() {
    throw new Error('Green wave offset chain is build step 14 (Phase 2), not implemented yet.');
}

export { DIRECTION_VECTORS, rightNormal, leftNormal, add as addVector };
