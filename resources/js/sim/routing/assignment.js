/**
 * routing/assignment.js - capacity-aware route choice: the junction delay a route meets grows with the traffic the
 * routes themselves send through each approach, and the routes are re-chosen against it until they settle - a
 * stochastic user equilibrium (Sheffi 1985, ch. 12; Daganzo & Sheffi 1977), solved once per layout by the method of
 * successive averages over Dial's logit loading (routing/odTable.js).
 *
 * Free-flow route choice sent every near-equal trip down the same side street whatever its capacity: Hilda south - one
 * lane each way through two single-lane roundabouts - got ~8 veh/min each way, both directions filled, each roundabout
 * held its entries for a full exit, and the south grid stood for 10-15 min at a time (batch c8f35fa8). Routes stay a
 * property of the layout and its design demand, not of the run: the same for every controller, with no live rerouting.
 *
 * An approach's capacity, by its junction's control (veh/h, all its lanes):
 *   signal      lanes x s x g/C, s the road's saturation flow (Webster's s), g/C an equisaturation split - each of the
 *               junction's two phases (arterial, cross street) gets green in proportion to its critical flow ratio y,
 *               after `signalLostShare` of the cycle is lost to clearance. Controller-independent by construction.
 *   roundabout  HCM 6th ed. eq. 22-1/22-2 entry capacity against the flow circulating past the entry (one circulating
 *               lane): 1380 e^(-1.02e-3 vc) for a one-lane entry, 1420 e^(-0.91e-3 vc) a lane for a wider one.
 *   allWayStop  HCM's degree-of-utilisation idea in its simplest form: every car crossing takes `allWayStopHeadwayS`
 *               of the junction, so an approach gets 3600 / h less the time the other approaches use.
 *   stop        the minor road gets the HCM two-way-stop potential capacity against the major road's flow
 *               (critical gap tc, follow-up tf); the major road never waits - no delay.
 * The delay added to a move's free-flow cost is Akçelik's time-dependent function (Akçelik 1991), which stays finite
 * past capacity: d = 900 T [(x - 1) + sqrt((x - 1)^2 + 8 J x / (Q T))] seconds, x = v/Q over a flow period of T hours.
 *
 * Junction capacity alone left a one-lane side street looking as roomy as a 2+2 arterial (Hilda south at v/c ~0.4 while
 * it stood in the runs): what a driver weighs is the road between the junctions too - its lanes, and how often a car
 * stops in the lane to turn into a driveway or one pulls out in front. So every road segment also gets a capacity
 * and the same delay function, by Akçelik's (1991, Table 1) road types:
 *   arterial                      1200 veh/h a lane, J 0.4 (arterial, interrupted flow)
 *   side street, no driveways      900 veh/h a lane, J 0.8 (secondary, interrupted)
 *   side street, dense driveways   600 veh/h a lane, J 1.6 (secondary, high friction)
 * A side street's segment sits between the last two in proportion to its access-point density (the driveways cars on
 * it turn into or pull out of, a km), reaching high friction at `highFrictionAccessPerKm`. The delay is per segment
 * (gate to gate), shared over the arcs that run along it by length.
 */

/** Defaults for `routing.assignment` (routing/config.js). */
export const ASSIGNMENT_DEFAULTS = {
    /** Method-of-successive-averages iterations. */
    iterations: 30,
    /** Akçelik's flow period T (h) and delay parameter J (0.4: secondary roads, interrupted flow). */
    flowPeriodH: 0.25,
    delayParameter: 0.4,
    /** Share of a signal's cycle lost to clearance between its phases. */
    signalLostShare: 0.1,
    /** Saturation flow (veh/h/lane) for a signal approach whose road carries none of its own (a merge or turn road). */
    saturationFlowPerLanePerHour: 1250,
    /** Box time per car at an all-way stop (s). */
    allWayStopHeadwayS: 4,
    /** HCM two-way-stop critical gap and follow-up headway for the minor road (s). */
    minorCriticalGapS: 6.5,
    minorFollowUpS: 3.5,
    /** Akçelik's (1991) road types for the segments between junctions: capacity a lane (veh/h) and delay parameter J. */
    linkTypes: {
        arterial: { capacityPerLanePerHour: 1200, delayParameter: 0.4 },
        side: { capacityPerLanePerHour: 900, delayParameter: 0.8 },
        sideHighFriction: { capacityPerLanePerHour: 600, delayParameter: 1.6 },
    },
    /** Driveways a km (on the segment, either kerb a car on it can use) at which a side street is high friction. */
    highFrictionAccessPerKm: 30,
};

/** Akçelik's delay (s) for flow `v` through capacity `q` (veh/h). */
export function akcelikDelayS(v, q, { flowPeriodH: T, delayParameter: J }) {
    if (!(v > 0)) return 0;
    if (!(q > 0)) q = 1;
    const x = v / q;
    return 900 * T * (x - 1 + Math.sqrt((x - 1) ** 2 + (8 * J * x) / (q * T)));
}

/**
 * Per approach (the graph state a move leaves from), its flow and capacity (veh/h) given each arc's flow
 * (`flowPerMinOf(arc)`, veh/min). Approaches through no capacity check (a stop street's major road) get Infinity.
 */
export function approachCapacities(graph, flowPerMinOf, params) {
    const approaches = new Map();
    for (const arc of graph.arcs) {
        if (arc.kind !== 'move') continue;
        let entry = approaches.get(arc.from);
        if (!entry) approaches.set(arc.from, (entry = { ...arc.approach, flowPerH: 0, capacityPerH: Infinity }));
        entry.flowPerH += 60 * flowPerMinOf(arc);
    }
    const byNode = new Map();
    for (const entry of approaches.values()) {
        if (!byNode.has(entry.nodeId)) byNode.set(entry.nodeId, []);
        byNode.get(entry.nodeId).push(entry);
    }
    // Circulating flow past each roundabout entry: the moves from other entries that drive past it.
    const circulating = new Map();
    for (const arc of graph.arcs) {
        if (arc.kind !== 'move' || !arc.passes) continue;
        for (const approachId of arc.passes) {
            const key = `${arc.nodeId}|${approachId}`;
            circulating.set(key, (circulating.get(key) ?? 0) + 60 * flowPerMinOf(arc));
        }
    }

    for (const [nodeId, entries] of byNode) {
        const { control } = entries[0];
        if (control === 'roundabout') {
            for (const e of entries) {
                const vc = circulating.get(`${nodeId}|${e.approachId}`) ?? 0;
                e.capacityPerH = e.lanes <= 1 ? 1380 * Math.exp(-1.02e-3 * vc) : e.lanes * 1420 * Math.exp(-0.91e-3 * vc);
            }
        } else if (control === 'allWayStop') {
            const h = params.allWayStopHeadwayS;
            const total = entries.reduce((s, e) => s + e.flowPerH, 0);
            for (const e of entries) e.capacityPerH = (3600 / h) * Math.max(0.05, 1 - ((total - e.flowPerH) * h) / 3600);
        } else if (control === 'stop') {
            const vc = entries.filter((e) => e.phase === 0).reduce((s, e) => s + e.flowPerH, 0);
            const { minorCriticalGapS: tc, minorFollowUpS: tf } = params;
            for (const e of entries) {
                if (e.phase === 0) continue;
                e.capacityPerH = vc > 0 ? (vc * Math.exp((-vc * tc) / 3600)) / (1 - Math.exp((-vc * tf) / 3600)) : 3600 / tf;
            }
        } else {
            // Signal: equisaturation green split between the arterial and cross-street phases.
            const satOf = (e) => e.lanes * (e.saturationFlowPerLanePerHour ?? params.saturationFlowPerLanePerHour);
            const y = [0, 0];
            for (const e of entries) y[e.phase === 0 ? 0 : 1] = Math.max(y[e.phase === 0 ? 0 : 1], e.flowPerH / satOf(e));
            const phases = y.filter((_, p) => entries.some((e) => (e.phase === 0 ? 0 : 1) === p)).length || 1;
            const ySum = y[0] + y[1];
            for (const e of entries) {
                const p = e.phase === 0 ? 0 : 1;
                const share = ySum > 0 ? y[p] / ySum : 1 / phases;
                const gC = Math.min(0.9, Math.max(0.1, (1 - params.signalLostShare) * share));
                e.capacityPerH = satOf(e) * gC;
            }
        }
    }
    return approaches;
}

/** Each arc's cost (s) with its approach's congestion delay - and with `segments`, its road segment's - on top of the free-flow cost. */
export function congestedCosts(graph, approaches, params, segments = null) {
    const delayByApproach = new Map([...approaches].map(([id, e]) => [id, Number.isFinite(e.capacityPerH) ? akcelikDelayS(e.flowPerH, e.capacityPerH, params) : 0]));
    const roadDelayOf = segments ? (arc) => segmentDelayOf(arc, segments.ofState, segments.delays) : () => 0;
    return new Map(graph.arcs.map((arc) => [arc, arc.costS + (arc.kind === 'move' ? delayByApproach.get(arc.from) ?? 0 : 0) + roadDelayOf(arc)]));
}

/**
 * Per road segment (gate to gate, one direction), its access-point density and Akçelik road type: `{ roadKey, fromM,
 * toM, lanes, accessPerKm, capacityPerLanePerHour, delayParameter }`, and for each graph state the segment it ends in.
 * `accessPointsByRoad`: road key -> the along-road positions (m) of the driveways a car on it can use.
 */
export function roadSegments(graph, accessPointsByRoad, params) {
    const { arterial, side, sideHighFriction: high } = params.linkTypes;
    const segmentOfState = new Map();
    for (const road of graph.roads.values()) {
        const cuts = [0, ...road.stops.filter((stop) => stop.type === 'gate').map((stop) => stop.atM), road.lengthM];
        const segments = [];
        for (let i = 1; i < cuts.length; i += 1) {
            const fromM = cuts[i - 1];
            const toM = cuts[i];
            const lengthM = Math.max(1, toM - fromM);
            const points = (accessPointsByRoad.get(road.key) ?? []).filter((atM) => atM >= fromM && atM < toM).length;
            const accessPerKm = (1000 * points) / lengthM;
            let type = arterial;
            if (road.scope !== 'arterial') {
                const f = Math.min(1, accessPerKm / params.highFrictionAccessPerKm);
                type = {
                    capacityPerLanePerHour: side.capacityPerLanePerHour + f * (high.capacityPerLanePerHour - side.capacityPerLanePerHour),
                    delayParameter: side.delayParameter + f * (high.delayParameter - side.delayParameter),
                };
            }
            segments.push({ roadKey: road.key, fromM, toM, lengthM, lanes: road.lanes, accessPerKm, ...type });
        }
        road.stops.forEach((stop, k) => {
            segmentOfState.set(`${road.key}#${k}`, segments.find((seg) => stop.atM > seg.fromM && stop.atM <= seg.toM) ?? segments[0]);
        });
        segmentOfState.set(`${road.key}#${road.stops.length}`, segments.at(-1));
    }
    return segmentOfState;
}

/**
 * Each segment's flow and congestion delay (s) given each arc's flow: an arc's flow runs along the segment its
 * destination state ends in, and is charged that segment's delay in proportion to the length it covers.
 */
export function segmentDelays(graph, segmentOfState, flowPerMinOf, params) {
    const flowPerH = new Map();
    for (const arc of graph.arcs) {
        const segment = segmentOfState.get(arc.to);
        if (!segment || !(arc.lengthM > 0)) continue;
        flowPerH.set(segment, (flowPerH.get(segment) ?? 0) + 60 * flowPerMinOf(arc) * Math.min(1, arc.lengthM / segment.lengthM));
    }
    const delays = new Map();
    for (const [segment, v] of flowPerH) {
        const q = segment.lanes * segment.capacityPerLanePerHour;
        delays.set(segment, { flowPerH: v, capacityPerH: q, delayS: akcelikDelayS(v, q, { ...params, delayParameter: segment.delayParameter }) });
    }
    return delays;
}

/** Each arc's road-segment congestion delay (s): its segment's delay, by the share of the segment it runs along. */
export function segmentDelayOf(arc, segmentOfState, delays) {
    const segment = segmentOfState.get(arc.to);
    const d = segment && delays.get(segment);
    return d ? d.delayS * Math.min(1, arc.lengthM / segment.lengthM) : 0;
}
