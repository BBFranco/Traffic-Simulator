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

/* ------------------------------------------------------------------ vectors */

const add = (p, v, k = 1) => ({ x: p.x + v.x * k, y: p.y + v.y * k });
/** Right-hand normal of `h` in screen axes (y down): facing east, right is south. */
const rightNormal = (h) => ({ x: -h.y, y: h.x });
/** Left-hand normal of `h`: the kerb side for left-hand traffic. */
const leftNormal = (h) => ({ x: h.y, y: -h.x });
const negate = (h) => ({ x: -h.x, y: -h.y });

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
            node.approaches = buildApproaches(node, arterial, laneWidthM);
        }
    }

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

    // Walk the intersection chain from the origin, accumulating distanceToNextM.
    let travelled = 0;
    const intersections = raw.intersections.map((node, index) => {
        const distanceToNextM = node.distanceToNextM ?? null;
        const built = {
            id: node.id,
            name: node.name,
            arterialId: raw.id,
            index,
            /** metres along the arterial centreline, measured from `origin`. */
            sAlongM: travelled,
            point: add(origin, heading, travelled),
            distanceToNextM,
            distanceFromPreviousM: index === 0 ? null : raw.intersections[index - 1].distanceToNextM ?? null,
            crossStreetName: node.crossStreetName ?? null,
            crossStreetLanes: node.crossStreetLanes ?? null,
            arterialLanes: lanes,
            arterialRoadWidthM: roadWidthM,
            arterialHeading: heading,
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
        /** Drawn/driveable extent, including the spawn lead-in and the run-out. */
        startPoint: add(origin, heading, -approachLengthM),
        endPoint: add(last.point, heading, exitLengthM),
        centrelineLengthM: approachLengthM + last.sAlongM + exitLengthM,
        intersections,
    };
}

function buildConnector(raw, nodesById, defaults, laneWidthM) {
    const links = raw.linksArterialNodes ?? [];
    if (links.length !== 2) {
        throw new Error(
            `Connector "${raw.id}" must link exactly 2 arterial nodes, got ${links.length}.`
        );
    }
    const [a, b] = links.map((id) => {
        const node = nodesById.get(id);
        if (!node) {
            throw new Error(`Connector "${raw.id}" references unknown intersection "${id}".`);
        }
        return node;
    });

    const dx = b.point.x - a.point.x;
    const dy = b.point.y - a.point.y;
    const span = Math.hypot(dx, dy);
    if (span < 1) {
        throw new Error(
            `Connector "${raw.id}" links two intersections at (nearly) the same point - ` +
                `check the arterial origins and distanceToNextM chain.`
        );
    }
    const heading = { x: dx / span, y: dy / span };
    const stub = raw.stubLengthM ?? defaults.crossStreetStubLengthM;
    const lanes = raw.lanes ?? 2;

    return {
        id: raw.id,
        name: raw.name,
        lanes,
        laneWidthM,
        roadWidthM: lanes * laneWidthM,
        twoWay: raw.twoWay ?? true,
        crossChance: raw.crossChance ?? 0,
        /** Connectors are never wave-coordinated - two-way streets have no single progression band. */
        mode: raw.mode ?? defaults.connectorMode,
        demand: buildDemand(raw.demand, raw.id, 4, 1800),
        nodeIds: [a.id, b.id],
        heading,
        spanM: span,
        stubLengthM: stub,
        // Poke past both arterials so it reads as a through street, not a stub.
        startPoint: add(a.point, heading, -stub),
        endPoint: add(b.point, heading, stub),
    };
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
        node.crossAxis = rightNormal(arterial.heading);
        node.crossLanes = node.crossStreetLanes ?? 2;
        node.crossStreetName = node.crossStreetName ?? 'Cross St';
        node.crossTwoWay = true;
        node.crossStub = {
            startPoint: add(node.point, node.crossAxis, -defaults.crossStreetStubLengthM),
            endPoint: add(node.point, node.crossAxis, defaults.crossStreetStubLengthM),
        };
    }

    node.crossRoadWidthM = node.crossLanes * laneWidthM;

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
function buildApproaches(node, arterial, laneWidthM) {
    const approaches = [];

    approaches.push(
        makeApproach({
            id: `${node.id}:${arterial.id}`,
            kind: 'arterial',
            label: arterial.shortName,
            node,
            heading: arterial.heading,
            lanes: arterial.lanes,
            roadWidthM: arterial.roadWidthM,
            // Stop line sits at the edge of the junction box, half a cross-road back.
            setbackM: node.crossRoadWidthM / 2,
            oneWay: true,
            laneWidthM,
        })
    );

    const crossHeadings = node.crossTwoWay
        ? [node.crossAxis, negate(node.crossAxis)]
        : [node.crossAxis];

    crossHeadings.forEach((heading, i) => {
        approaches.push(
            makeApproach({
                id: `${node.id}:cross:${i}`,
                kind: 'cross',
                label: node.crossStreetName,
                node,
                heading,
                lanes: node.crossTwoWay ? Math.max(1, Math.floor(node.crossLanes / 2)) : node.crossLanes,
                roadWidthM: node.crossRoadWidthM,
                setbackM: node.arterialRoadWidthM / 2,
                oneWay: !node.crossTwoWay,
                laneWidthM,
            })
        );
    });

    return approaches;
}

function makeApproach({ id, kind, label, node, heading, lanes, roadWidthM, setbackM, oneWay, laneWidthM }) {
    const right = rightNormal(heading);
    const left = leftNormal(heading);

    // Stop-line centre: `setbackM` upstream of the junction centre.
    const stopCentre = add(node.point, heading, -setbackM);

    // A one-way road's approach spans the whole carriageway. On a two-way road
    // only the left half approaches (left-hand traffic).
    const stopLine = oneWay
        ? { a: add(stopCentre, right, -roadWidthM / 2), b: add(stopCentre, right, roadWidthM / 2) }
        : { a: stopCentre, b: add(stopCentre, left, roadWidthM / 2) };

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
        /** Signal head stands on the left kerb, level with the stop line. */
        signalHead: add(add(stopCentre, left, roadWidthM / 2 + 3), heading, -1.5),
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
        include(connector.startPoint, pad);
        include(connector.endPoint, pad);
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
