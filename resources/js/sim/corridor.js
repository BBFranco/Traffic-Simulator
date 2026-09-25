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

    return {
        lengthM,
        points: samples.map((s) => s.point),
        sampleAt,
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
function buildDemand(raw, id, defaultSpawnRatePerLanePerMin, defaultSaturationFlowPerLanePerHour) {
    const saturationFlowPerLanePerHour = raw?.saturationFlowPerLanePerHour ?? defaultSaturationFlowPerLanePerHour;
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

    const connectors = (config.connectors ?? []).map((raw) =>
        buildConnector(raw, nodesById, defaults, laneWidthM)
    );

    // Every intersection gets a cross street. If a connector runs through it the
    // cross street IS that connector (and the pair of nodes it links is what
    // cross-routing will use in build step 13); otherwise it is a local stub so
    // the intersection still reads - and signals - as a 4-way.
    for (const arterial of arterials) {
        for (const node of arterial.intersections) {
            resolveCrossStreet(node, arterial, connectors, defaults, laneWidthM);
            node.approaches = buildApproaches(node, arterial, laneWidthM, connectors);
        }
    }
    for (const connector of connectors) checkConnectorLaneUseKeys(connector, nodesById);

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

function buildArterial(raw, laneWidthM) {
    const heading = DIRECTION_VECTORS[raw.direction];
    if (!heading) {
        throw new Error(
            `Arterial "${raw.id}" has unknown direction "${raw.direction}". ` +
                `Expected one of: ${Object.keys(DIRECTION_VECTORS).join(', ')}.`
        );
    }
    if (!Array.isArray(raw.intersections) || raw.intersections.length === 0) {
        throw new Error(`Arterial "${raw.id}" defines no intersections.`);
    }

    const origin = { x: raw.origin?.xM ?? 0, y: raw.origin?.yM ?? 0 };
    const approachLengthM = raw.approachLengthM ?? 200;
    const exitLengthM = raw.exitLengthM ?? 200;
    const lanes = raw.lanes ?? 1;
    const roadWidthM = lanes * laneWidthM;
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
            /** Per arterial lane (kerb first), which movements that lane may make at this node. */
            laneUse: parseLaneUse(node.laneUse, lanes, `Intersection "${node.id}"`),
            /** The arterial approach's `turnLanes` as written in the config - parsed in buildApproaches(). */
            rawTurnLanes: node.turnLanes ?? null,
            arterialLanes: lanes,
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
        oneWay: raw.oneWay ?? true,
        direction: raw.direction,
        heading,
        lanes,
        laneWidthM,
        roadWidthM,
        targetSpeedKph: raw.targetSpeedKph ?? 50,
        /** Initial controller mode from config; the UI overrides this per arterial at runtime. */
        mode: raw.mode ?? 'fixed',
        demand: buildDemand(raw.demand, raw.id, 8, 1900),
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

function buildConnector(raw, nodesById, defaults, laneWidthM) {
    const links = raw.linksArterialNodes ?? [];
    if (links.length !== 1 && links.length !== 2) {
        throw new Error(
            `Connector "${raw.id}" must link 1 or 2 arterial nodes, got ${links.length}.`
        );
    }
    const linked = links.map((id) => {
        const node = nodesById.get(id);
        if (!node) {
            throw new Error(`Connector "${raw.id}" references unknown intersection "${id}".`);
        }
        return node;
    });
    // A connector through a single node (the road editor's one-junction test
    // layout) is its own "both ends": zero span, a stub either side, running
    // in its own compass `direction`. Everything downstream treats it as a
    // connector whose two linked nodes happen to coincide.
    const [a, b] = linked.length === 2 ? linked : [linked[0], linked[0]];
    if (linked.length === 1 && raw.curve) {
        throw new Error(`Connector "${raw.id}" links one intersection, so it can't be curved.`);
    }
    const singleHeading = linked.length === 1 ? DIRECTION_VECTORS[raw.direction] : null;
    if (linked.length === 1 && !singleHeading) {
        throw new Error(`Connector "${raw.id}" links one intersection, so it needs a "direction" (${Object.keys(DIRECTION_VECTORS).join(', ')}).`);
    }

    const dx = b.point.x - a.point.x;
    const dy = b.point.y - a.point.y;
    const span = Math.hypot(dx, dy);
    if (!singleHeading && span < 1) {
        throw new Error(
            `Connector "${raw.id}" links two intersections at (nearly) the same point - ` +
                `check the arterial origins and distanceToNextM chain.`
        );
    }
    const straightHeading = singleHeading ?? { x: dx / span, y: dy / span };
    const stub = raw.stubLengthM ?? defaults.crossStreetStubLengthM;
    const lanes = raw.lanes ?? 2;
    const curve = raw.curve ? buildCurve(raw.curve, raw.id) : null;
    const twoWay = raw.twoWay ?? true;
    /** Raised island between the two directions of a two-way street (metres); part of the carriageway width, never a lane. */
    const medianWidthM = twoWay ? raw.medianWidthM ?? 0 : 0;

    const connector = {
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
        /** `{ nodeId: { northbound: [...], ... } }` as written in the config - parsed per approach in buildApproaches(). */
        rawLaneUse: raw.laneUse ?? {},
        /** `{ nodeId: { northbound: { right: {...} }, ... } }` - same keys as `rawLaneUse`, parsed in buildApproaches(). */
        rawTurnLanes: raw.turnLanes ?? {},
        /** Side-street speed limit - lower than a typical arterial's when a corridor doesn't give one. */
        targetSpeedKph: raw.targetSpeedKph ?? 40,
        /** Connectors are never wave-coordinated - two-way streets have no single progression band. */
        mode: raw.mode ?? defaults.connectorMode,
        demand: buildDemand(raw.demand, raw.id, 4, 1800),
        /** Both linked nodes - the same id twice for a single-node connector. */
        nodeIds: [a.id, b.id],
        /** Set only for a curved connector (a ramp) - see roadPointAt() and its reversed() counterpart for the 'rev' direction. */
        curve,
        curveReversed: curve ? curve.reversed() : null,
    };

    if (curve) {
        // A curved ramp's own endpoints are where it starts/ends - unlike a
        // straight through-street, there's no "stub" reading beyond the
        // linked intersections.
        connector.heading = curve.sampleAt(0).heading;
        connector.spanM = curve.lengthM;
        connector.stubLengthM = 0;
        connector.startPoint = curve.points[0];
        connector.endPoint = curve.points[curve.points.length - 1];
    } else {
        connector.heading = straightHeading;
        connector.spanM = span;
        connector.stubLengthM = stub;
        // Poke past both arterials so it reads as a through street, not a stub.
        connector.startPoint = add(a.point, straightHeading, -stub);
        connector.endPoint = add(b.point, straightHeading, stub);
    }

    return connector;
}

function resolveCrossStreet(node, arterial, connectors, defaults, laneWidthM) {
    const connector = connectors.find((c) => c.nodeIds.includes(node.id));

    if (connector) {
        node.connectorId = connector.id;
        node.crossStreetName = node.crossStreetName ?? connector.name;
        node.crossAxis = connector.heading;
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

    // The junction footprint: as wide as the cross road along the arterial, as
    // deep as the arterial road across it.
    node.box = {
        alongArterialM: node.crossRoadWidthM,
        acrossArterialM: node.arterialRoadWidthM,
    };
}

/**
 * One approach per incoming direction: the arterial (one-way, so all lanes
 * approach together) plus the cross street's one or two directions.
 */
function buildApproaches(node, arterial, laneWidthM, connectors) {
    const approaches = [];
    const connector = connectors.find((c) => c.id === node.connectorId) ?? null;

    const arterialApproach = makeApproach({
        id: `${node.id}:${arterial.id}`,
        kind: 'arterial',
        label: arterial.shortName,
        node,
        heading: node.arterialHeading,
        lanes: arterial.lanes,
        roadWidthM: arterial.roadWidthM,
        // Stop line sits at the edge of the junction box, half a cross-road back.
        setbackM: node.crossRoadWidthM / 2,
        oneWay: true,
        laneWidthM,
        turnLanes: parseTurnLanes(node.rawTurnLanes, `Intersection "${node.id}"`, { oneWay: true, medianWidthM: 0, laneWidthM }),
    });
    /** Per lane (kerb first), the movements it may make - the same array as `node.laneUse`, so an edit to one is an edit to both. */
    arterialApproach.laneUse = node.laneUse;
    /** Where this approach's lane use lives in the corridor JSON - 'arterial' (the node's own) or a connector direction's compass name. */
    arterialApproach.laneUseKey = 'arterial';
    approaches.push(arterialApproach);

    const crossHeadings = node.crossTwoWay
        ? [node.crossAxis, negate(node.crossAxis)]
        : [node.crossAxis];

    crossHeadings.forEach((heading, i) => {
        const laneUseKey = compassDirection(heading);
        const approach = makeApproach({
            id: `${node.id}:cross:${i}`,
            kind: 'cross',
            label: node.crossStreetName,
            node,
            heading,
            lanes: node.crossTwoWay ? Math.max(1, Math.floor(node.crossLanes / 2)) : node.crossLanes,
            roadWidthM: node.crossRoadWidthM,
            medianWidthM: node.crossMedianWidthM,
            setbackM: node.arterialRoadWidthM / 2,
            oneWay: !node.crossTwoWay,
            laneWidthM,
            // A local stub carries no traffic, so it has no turn lanes either.
            turnLanes: parseTurnLanes(connector?.rawTurnLanes[node.id]?.[laneUseKey], `Connector "${connector?.id}" at "${node.id}" ${laneUseKey}`, {
                oneWay: !node.crossTwoWay,
                medianWidthM: node.crossMedianWidthM,
                laneWidthM,
            }),
        });
        // Only a real cross street (a connector) carries traffic - a local stub
        // has no lanes to mark. crossAxis is the connector's own heading, so the
        // first cross approach is its 'fwd' direction and the second its 'rev'.
        if (connector) {
            approach.connectorId = connector.id;
            approach.dirKey = i === 0 ? 'fwd' : 'rev';
            approach.laneUseKey = laneUseKey;
            approach.laneUse = parseLaneUse(
                connector.rawLaneUse[node.id]?.[approach.laneUseKey],
                approach.lanes,
                `Connector "${connector.id}" at "${node.id}" ${approach.laneUseKey}`,
                // The arterial is one-way, so a cross approach can only turn onto it one way (y points south: a positive cross product is a right turn).
                ['straight', heading.x * node.arterialHeading.y - heading.y * node.arterialHeading.x > 0 ? 'right' : 'left']
            );
        }
        approaches.push(approach);
    });

    return approaches;
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
                .approaches.filter((a) => a.kind === 'cross')
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
