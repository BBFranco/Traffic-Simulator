/**
 * routing/odTable.js - who goes where, and which way: the origin-destination
 * split and the routes, computed once per layout + seed (Step 3).
 *
 * Destinations are the map's exits (through traffic) and the block directions
 * (cars pulling off along a block). Origins are the spawning road directions,
 * and every block direction with driveways: it sends out as many cars as the
 * roads send into the block (trip balance), on top of the roads' demand. Each origin
 * splits its demand: `throughShare` (by origin class) to the exits, the rest
 * to the blocks, and within each group by weight x exp(-decay x free-flow
 * time). Pairs whose route is more than `detourLimit` times the straight-line
 * distance are dropped (the Prospect/Lunnon turn-road loops).
 *
 * Routes are next-hop tables, not fixed paths: for each route variant and
 * destination, the best arc out of every graph state. A car follows its
 * table from wherever it is, so a missed turn needs no replanning - the table
 * already knows the best way on from the state it ended up in. Variants add
 * seeded +-`routeCostNoise` per arc so parallel streets share the load.
 *
 * With `routeChoice` set, variants are Dial's logit route choice instead (Dial
 * 1971, STOCH): at each state a car picks among the arcs that take it strictly
 * closer to its destination (free-flow), weighted exp(-thetaPerS x the extra
 * cost of that arc over the best one). Per-arc noise averages out over a
 * 10-15 junction route, so a route 3% dearer never won a single variant and
 * every car took one side street (Duxbury/Herold/Hilda north, the Lunnon slip
 * by 1 s); here two routes 10 s apart share the traffic. A variant is a
 * seeded draw at every state (routeChoiceTables()), so a car still follows one
 * fixed table, and the expected flows are the exact split, not a sample.
 */
import { roadPointAt } from '../corridor.js';
import { SeededRandom } from '../rng.js';
import { approachCapacities, congestedCosts, roadSegments, segmentDelays } from './assignment.js';
import { stateId } from './graph.js';

/** Pairs closer than this are never dropped as detours - a short hop is always reasonable. */
const DETOUR_MIN_STRAIGHT_M = 100;

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Where a car leaving a driveway on block direction `dir` sets out from, for its route: the block's middle,
 * heading for the first stop past it.
 */
function blockDepartureState(graph, dir) {
    const { roadKey, atM } = dir.midpoint;
    const road = graph.roads.get(roadKey);
    const k = road.stops.findIndex((s) => s.atM > atM);
    const index = k === -1 ? road.stops.length : k;
    const toM = index < road.stops.length ? road.stops[index].atM : road.lengthM;
    return { roadKey, stateId: stateId(roadKey, index), point: roadPointAt(road.road, atM).point, firstRunM: toM - atM, firstRunS: (toM - atM) / road.speedMps };
}

/** The state a car is in once it reaches a block direction: heading for the first stop past the block's start. */
function blockEntryState(graph, dir) {
    const piece = dir.pieces[0];
    const road = graph.roads.get(piece.roadKey);
    const k = road.stops.findIndex((s) => s.atM > piece.fromM + 0.5);
    return stateId(road.key, k === -1 ? road.stops.length : k);
}

/** Least cost from every state to `target`, and each state's best arc towards it (reverse Dijkstra). */
function towards(graph, arcsTo, target, costOf) {
    const dist = new Map([[target, 0]]);
    const next = new Map();
    const queue = [[0, target]];
    while (queue.length) {
        // The graph is small (a few hundred states) - a sorted pop keeps this simple.
        let best = 0;
        for (let i = 1; i < queue.length; i += 1) if (queue[i][0] < queue[best][0]) best = i;
        const [d, id] = queue.splice(best, 1)[0];
        if (d > dist.get(id)) continue;
        for (const arc of arcsTo.get(id) ?? []) {
            const nd = d + costOf(arc);
            if (nd < (dist.get(arc.from) ?? Infinity)) {
                dist.set(arc.from, nd);
                next.set(arc.from, arc);
                queue.push([nd, arc.from]);
            }
        }
    }
    return { dist, next };
}

/** 32-bit FNV-1a of a string. */
function hashString(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return h >>> 0;
}

/** murmur3's finaliser: a well-mixed 32-bit value from `h`, as a fraction in [0, 1). */
function mixUnit(h) {
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Dial's choice sets towards one destination: per state, the arcs that end strictly closer to it (or the best arc,
 * whatever it costs - an exit arc is free) with their logit weights. Strictly closer keeps every route loop-free.
 */
function dialChoices({ dist, next }, arcsFrom, thetaPerS, costOf = (arc) => arc.costS) {
    const choices = new Map();
    for (const [from, best] of next) {
        const d = dist.get(from);
        const arcs = [];
        const weights = [];
        for (const arc of arcsFrom.get(from) ?? []) {
            const dTo = dist.get(arc.to);
            if (dTo == null || (arc !== best && !(dTo < d - 1e-9))) continue;
            arcs.push(arc);
            weights.push(Math.exp(-thetaPerS * Math.max(0, costOf(arc) + dTo - d)));
        }
        const total = weights.reduce((s, w) => s + w, 0);
        choices.set(from, arcs.length === 1 ? { arcs, probs: [1] } : { arcs, probs: weights.map((w) => w / total) });
    }
    return choices;
}

/**
 * The exact Dial split: each destination's trips (`tripsTo`: dest id -> state id -> { mean, peak } veh/min) poured in
 * at their origins and spread down its choice sets, furthest from the destination first, so every state has all its
 * inflow before it splits it on. Returns every arc's flow (veh/min, mean and peak); `onSplit(arc, mean, peak)`, if given,
 * also sees each share as it is passed on.
 */
function dialLoading(tripsTo, trees, choicesByDest, onSplit = null) {
    const flows = new Map();
    for (const [destId, trips] of tripsTo) {
        const mass = new Map([...trips].map(([id, m]) => [id, { mean: m.mean, peak: m.peak }]));
        const { dist } = trees.get(destId);
        const choices = choicesByDest.get(destId);
        const queue = [...mass.keys()];
        const queued = new Set(queue);
        while (queue.length) {
            // Furthest first: dist strictly falls along every choice, so nothing reaches a state after it has split.
            let far = 0;
            for (let i = 1; i < queue.length; i += 1) if (dist.get(queue[i]) > dist.get(queue[far])) far = i;
            const id = queue.splice(far, 1)[0];
            const here = mass.get(id);
            const choice = choices.get(id);
            if (!choice) continue;
            choice.arcs.forEach((arc, i) => {
                const p = choice.probs[i];
                onSplit?.(arc, here.mean * p, here.peak * p);
                const flow = flows.get(arc) ?? { mean: 0, peak: 0 };
                flow.mean += here.mean * p;
                flow.peak += here.peak * p;
                flows.set(arc, flow);
                const on = mass.get(arc.to) ?? { mean: 0, peak: 0 };
                on.mean += here.mean * p;
                on.peak += here.peak * p;
                mass.set(arc.to, on);
                if (!queued.has(arc.to)) {
                    queued.add(arc.to);
                    queue.push(arc.to);
                }
            });
        }
    }
    return flows;
}

/**
 * `count` route variants over Dial choice sets, each read like a noise variant's table (`.get(destId).get(stateId)`,
 * `.has()`): variant v at a state takes the arc its seeded draw lands on. Built lazily per destination, so 64 variants
 * cost no more memory than one.
 */
function routeChoiceTables(choicesByDest, count) {
    const stateHash = new Map();
    const hashOf = (id) => stateHash.get(id) ?? stateHash.set(id, hashString(id)).get(id);
    return Array.from({ length: count }, (_, v) => {
        const tables = new Map();
        return {
            get(destId) {
                if (tables.has(destId)) return tables.get(destId);
                const choices = choicesByDest.get(destId);
                if (!choices) return undefined;
                const salt = Math.imul(hashString(destId), 0x9e3779b1) ^ Math.imul(v + 1, 0x85ebca77);
                const table = {
                    has: (id) => choices.has(id),
                    get(id) {
                        const choice = choices.get(id);
                        if (!choice) return undefined;
                        if (choice.arcs.length === 1) return choice.arcs[0];
                        const u = mixUnit(salt ^ hashOf(id));
                        let sum = 0;
                        for (let i = 0; i < choice.arcs.length; i += 1) if (u < (sum += choice.probs[i])) return choice.arcs[i];
                        return choice.arcs.at(-1);
                    },
                };
                tables.set(destId, table);
                return table;
            },
        };
    });
}

/** Follows `next` from `from` to `target`: the arcs driven, or null if it can't get there. */
export function followRoute(next, from, target, maxArcs = 200) {
    const arcs = [];
    for (let at = from; at !== target; ) {
        const arc = next.get(at);
        if (!arc || arcs.length > maxArcs) return null;
        arcs.push(arc);
        at = arc.to;
    }
    return arcs;
}

/**
 * @param graph     routing/graph.js's graph
 * @param blocks    routing/blocks.js's resolved blocks
 * @param drivewayDirs  routing/driveways.js's `dirs` (weight per block direction, after hand-offs)
 * @param routing   the layout's parsed `routing`
 * @param seed      route-variant noise seed
 */
export function buildOdTable(graph, blocks, drivewayDirs, routing, seed = 1) {
    // Destinations.
    const destinations = [];
    for (const exit of graph.exits) {
        const road = graph.roads.get(exit.roadKey);
        destinations.push({ id: exit.id, kind: 'exit', target: exit.id, point: exit.point, weight: road.lanes * (road.demand?.spawnRatePerLanePerMin ?? 0), roadKey: road.key });
    }
    for (const block of blocks) {
        for (const dir of block.dirs) {
            const weight = drivewayDirs.get(dir.id)?.weight ?? 0;
            if (!(weight > 0)) continue;
            const mid = graph.roads.get(dir.midpoint.roadKey);
            destinations.push({ id: dir.id, kind: 'block', blockId: block.id, target: blockEntryState(graph, dir), point: roadPointAt(mid.road, dir.midpoint.atM).point, weight, lengthM: dir.lengthM });
        }
    }

    const destinationsById = new Map(destinations.map((dest) => [dest.id, dest]));

    // Route variants: per-arc cost noise, then next-hop tables per destination.
    const arcsTo = new Map();
    for (const arc of graph.arcs) {
        if (!arcsTo.has(arc.to)) arcsTo.set(arc.to, []);
        arcsTo.get(arc.to).push(arc);
    }
    // Free-flow (no noise) costs, for the destination choice and the detour check.
    const freeFlow = new Map(destinations.map((dest) => [dest.id, towards(graph, arcsTo, dest.target, (arc) => arc.costS)]));
    const { routeChoice } = routing;

    // Per origin: candidates, detour filter, shares.
    let maxRoute = { timeS: 0 };
    /**
     * An origin's split over the destinations it can reach - `skip(dest)` leaves some out (a block's own block). With
     * `endToEnd` set, that share of all its trips goes to the far end of its own road (`ownExitId`), taken out of the
     * exit group; the rest of the group is spread over the other exits by attraction as usual.
     */
    const split = (origin, throughShare, skip, { ownExitId = null, endToEnd = null } = {}) => {
        const candidates = [];
        const dropped = [];
        for (const dest of destinations) {
            if (skip(dest)) continue;
            const { dist, next } = freeFlow.get(dest.id);
            if (!dist.has(origin.stateId)) continue;
            const arcs = followRoute(next, origin.stateId, dest.target);
            const routeM = origin.firstRunM + arcs.reduce((s, a) => s + a.lengthM, 0);
            const timeS = origin.firstRunS + dist.get(origin.stateId);
            /** Pure driving time on the free-flow route - no junction or turn penalties: what a trip's delay is measured against. */
            const runS = origin.firstRunS + arcs.reduce((s, a) => s + a.runS, 0);
            const straightM = dist2(origin.point, dest.point);
            if (straightM > DETOUR_MIN_STRAIGHT_M && routeM / straightM > routing.detourLimit) {
                dropped.push({ dest: dest.id, ratio: routeM / straightM });
                continue;
            }
            if (timeS > maxRoute.timeS) maxRoute = { timeS, from: origin.key ?? origin.roadKey, to: dest.id };
            candidates.push({ dest, timeS, runS, routeM, attraction: dest.weight * Math.exp(-routing.decayPerSecond * timeS) });
        }

        const allExits = candidates.filter((c) => c.dest.kind === 'exit');
        const blockDests = candidates.filter((c) => c.dest.kind === 'block');
        const groupShare = { exit: allExits.length ? (blockDests.length ? throughShare : 1) : 0 };
        groupShare.block = 1 - groupShare.exit;
        const shares = [];
        const own = endToEnd == null ? null : allExits.find((c) => c.dest.id === ownExitId);
        const exits = own ? allExits.filter((c) => c !== own) : allExits;
        if (own) {
            const ownShare = exits.length ? Math.min(endToEnd, groupShare.exit) : groupShare.exit;
            shares.push({ destId: own.dest.id, kind: 'exit', share: ownShare, timeS: own.timeS, runS: own.runS, routeM: own.routeM });
            groupShare.exit -= ownShare;
        }
        for (const [group, list] of [['exit', exits], ['block', blockDests]]) {
            const total = list.reduce((s, c) => s + c.attraction, 0);
            for (const c of list) shares.push({ destId: c.dest.id, kind: group, share: total ? (groupShare[group] * c.attraction) / total : 0, timeS: c.timeS, runS: c.runS, routeM: c.routeM });
        }
        return { shares, dropped };
    };

    const origins = [];
    for (const origin of graph.origins) {
        const road = graph.roads.get(origin.roadKey);
        const throughShare = road.scope === 'arterial' ? routing.throughShare.arterial : routing.throughShare.side;
        // Its own road's far end is an exit like any other - straight through is a trip too. The road's other direction
        // leaves by the very edge this one came in at: through traffic doesn't turn back out where it entered (a car that
        // does is visiting a block), and those round trips looped U-turns round the Herold roundabouts for nothing.
        const backOut = (dest) => dest.kind === 'exit' && dest.roadKey !== origin.roadKey && graph.roads.get(dest.roadKey).roadId === road.roadId;
        const { shares, dropped } = split(origin, throughShare, backOut, {
            ownExitId: destinations.find((dest) => dest.kind === 'exit' && dest.roadKey === origin.roadKey)?.id ?? null,
            endToEnd: road.scope === 'arterial' ? routing.endToEndShare : null,
        });
        const demand = road.demand ?? { spawnRatePerLanePerMin: 0, fluctuation: null };
        origins.push({
            key: origin.roadKey,
            kind: 'road',
            roadKey: origin.roadKey,
            stateId: origin.stateId,
            scope: road.scope,
            /** Design (sinusoid mean) and peak arrival rates, veh/min over all lanes. */
            meanPerMin: road.lanes * demand.spawnRatePerLanePerMin,
            peakPerMin: road.lanes * (demand.fluctuation?.maxPerLanePerMin ?? demand.spawnRatePerLanePerMin),
            shares,
            dropped,
        });
    }

    // Departures from the driveways: each block sends out as many cars as the roads send in (trip balance), split
    // over its directions; they head out to the exits or other blocks by the same rules, never back into their own block.
    const arrivalsByBlock = new Map();
    for (const origin of origins) {
        for (const { destId, share } of origin.shares) {
            const dest = destinationsById.get(destId);
            if (dest.kind !== 'block') continue;
            const sum = arrivalsByBlock.get(dest.blockId) ?? { meanPerMin: 0, peakPerMin: 0, byRoad: new Map() };
            sum.meanPerMin += origin.meanPerMin * share;
            sum.peakPerMin += origin.peakPerMin * share;
            sum.byRoad.set(origin.roadKey, (sum.byRoad.get(origin.roadKey) ?? 0) + share);
            arrivalsByBlock.set(dest.blockId, sum);
        }
    }
    for (const block of blocks) {
        const arrivals = arrivalsByBlock.get(block.id);
        const dirs = block.dirs.filter((dir) => drivewayDirs.get(dir.id)?.reach.length);
        if (!arrivals || !dirs.length) continue;
        for (const dir of dirs) {
            const origin = { key: `block:${dir.id}`, ...blockDepartureState(graph, dir) };
            const { shares, dropped } = split(origin, routing.throughShare.block, (dest) => dest.blockId === block.id);
            origins.push({
                ...origin,
                kind: 'block',
                blockId: block.id,
                dirId: dir.id,
                scope: 'block',
                meanPerMin: arrivals.meanPerMin / dirs.length,
                peakPerMin: arrivals.peakPerMin / dirs.length,
                /** Per road origin, the share of its design flow this direction's departures mirror - their live rate follows those roads' (engine.js). */
                fromRoads: [...arrivals.byRoad].map(([roadKey, share]) => ({ roadKey, share: share / dirs.length })),
                shares,
                dropped,
            });
        }
    }

    // Departures at `share` of the balanced rate; with `holdTotal`, every origin scaled so the total is the edges' alone.
    const { share: departureShare, holdTotal } = routing.departures;
    const edgePerMin = origins.filter((o) => o.kind === 'road').reduce((sum, o) => sum + o.meanPerMin, 0);
    const departurePerMin = origins.filter((o) => o.kind === 'block').reduce((sum, o) => sum + o.meanPerMin, 0) * departureShare;
    /** What every origin's demand is multiplied by - the edge spawns' too (engine.js reads it). */
    const demandScale = holdTotal && edgePerMin + departurePerMin > 0 ? edgePerMin / (edgePerMin + departurePerMin) : 1;
    for (const origin of origins) {
        const factor = demandScale * (origin.kind === 'block' ? departureShare : 1);
        origin.meanPerMin *= factor;
        origin.peakPerMin *= factor;
        for (const road of origin.fromRoads ?? []) road.share *= factor;
    }

    // Expected flow per movement (what fixed-time / green-wave signal timing will read in Step 5).
    const expectedMovementFlow = new Map();
    const addFlow = (arc, perMin, peakPerMin) => {
        const key = arc.kind === 'move' ? `${graph.states.get(arc.from).roadKey}@${arc.nodeId}` : `${arc.kind}#${arc.joinIndex}`;
        const movement = arc.kind === 'move' ? arc.movement : arc.kind;
        if (!expectedMovementFlow.has(key)) expectedMovementFlow.set(key, {});
        const entry = expectedMovementFlow.get(key);
        entry[movement] ??= { meanPerMin: 0, peakPerMin: 0 };
        entry[movement].meanPerMin += perMin;
        entry[movement].peakPerMin += peakPerMin;
    };
    const variants = [];
    /** With `routing.assignment`, how the capacity-aware routes settled (routing/assignment.js) - for the record. */
    let assignmentReport = null;
    if (routeChoice) {
        const tripsTo = new Map();
        for (const origin of origins) {
            for (const { destId, share } of origin.shares) {
                if (!tripsTo.has(destId)) tripsTo.set(destId, new Map());
                const at = tripsTo.get(destId);
                const mass = at.get(origin.stateId) ?? { mean: 0, peak: 0 };
                mass.mean += origin.meanPerMin * share;
                mass.peak += origin.peakPerMin * share;
                at.set(origin.stateId, mass);
            }
        }
        /** Dial's choice sets per destination under `costOf`, with the trees they were read from. */
        const chooseUnder = (costOf) => {
            const trees = costOf ? new Map(destinations.map((dest) => [dest.id, towards(graph, arcsTo, dest.target, costOf)])) : freeFlow;
            const choices = new Map(destinations.map((dest) => [dest.id, dialChoices(trees.get(dest.id), graph.arcsFrom, routeChoice.thetaPerS, costOf ?? undefined)]));
            return { trees, choices };
        };
        let routes = chooseUnder(null);
        if (routing.assignment) {
            // Method of successive averages: load under the costs of the averaged flows, fold the new loading in at 1/n.
            const params = routing.assignment;
            // The driveways cars on each road direction can turn into or pull out of - the road segments' friction.
            const accessPointsByRoad = new Map();
            for (const dir of drivewayDirs.values()) {
                for (const point of dir.reach) {
                    if (!accessPointsByRoad.has(point.roadKey)) accessPointsByRoad.set(point.roadKey, []);
                    accessPointsByRoad.get(point.roadKey).push(point.atM);
                }
            }
            const segmentOfState = roadSegments(graph, accessPointsByRoad, params);
            const costsOf = (averaged) => {
                const flowOf = (arc) => averaged.get(arc)?.mean ?? 0;
                return congestedCosts(graph, approachCapacities(graph, flowOf, params), params, { ofState: segmentOfState, delays: segmentDelays(graph, segmentOfState, flowOf, params) });
            };
            let averaged = dialLoading(tripsTo, routes.trees, routes.choices);
            let changePerMin = 0;
            for (let n = 2; n <= params.iterations; n += 1) {
                const costs = costsOf(averaged);
                routes = chooseUnder((arc) => costs.get(arc));
                const loaded = dialLoading(tripsTo, routes.trees, routes.choices);
                changePerMin = 0;
                const next = new Map();
                for (const arc of new Set([...averaged.keys(), ...loaded.keys()])) {
                    const a = averaged.get(arc) ?? { mean: 0, peak: 0 };
                    const b = loaded.get(arc) ?? { mean: 0, peak: 0 };
                    const mean = a.mean + (b.mean - a.mean) / n;
                    if (arc.kind === 'move') changePerMin = Math.max(changePerMin, Math.abs(mean - a.mean));
                    next.set(arc, { mean, peak: a.peak + (b.peak - a.peak) / n });
                }
                averaged = next;
            }
            const finalCosts = costsOf(averaged);
            routes = chooseUnder((arc) => finalCosts.get(arc));
            const approaches = approachCapacities(graph, (arc) => averaged.get(arc)?.mean ?? 0, params);
            const segments = segmentDelays(graph, segmentOfState, (arc) => averaged.get(arc)?.mean ?? 0, params);
            assignmentReport = {
                iterations: params.iterations,
                /** Largest change in any move's flow on the last iteration (veh/min) - how settled the averaging is. */
                lastChangePerMin: changePerMin,
                /** Approaches at or over capacity at the settled flows: state id -> { flowPerH, capacityPerH }. */
                saturated: [...approaches].filter(([, e]) => e.flowPerH >= e.capacityPerH).map(([id, e]) => ({ id, nodeId: e.nodeId, flowPerH: Math.round(e.flowPerH), capacityPerH: Math.round(e.capacityPerH) })),
                /** Road segments at or over capacity at the settled flows. */
                saturatedSegments: [...segments].filter(([, d]) => d.flowPerH >= d.capacityPerH).map(([seg, d]) => ({ roadKey: seg.roadKey, fromM: Math.round(seg.fromM), toM: Math.round(seg.toM), flowPerH: Math.round(d.flowPerH), capacityPerH: Math.round(d.capacityPerH) })),
            };
        }
        // The exact Dial split under the routes cars will follow - what signal timing reads.
        dialLoading(tripsTo, routes.trees, routes.choices, (arc, mean, peak) => {
            if (arc.kind === 'move' || arc.kind === 'peel' || arc.kind === 'slip') addFlow(arc, mean, peak);
        });
        variants.push(...routeChoiceTables(routes.choices, routeChoice.variants));
    } else {
        const rng = new SeededRandom(seed);
        for (let v = 0; v < routing.routeVariants; v += 1) {
            const factor = new Map(graph.arcs.map((arc) => [arc, 1 + routing.routeCostNoise * (2 * rng.next() - 1)]));
            const costOf = (arc) => arc.costS * factor.get(arc);
            const next = new Map();
            for (const dest of destinations) next.set(dest.id, towards(graph, arcsTo, dest.target, costOf).next);
            variants.push(next);
        }
        for (const origin of origins) {
            for (const { destId, share } of origin.shares) {
                const target = destinationsById.get(destId).target;
                for (const next of variants) {
                    const arcs = followRoute(next.get(destId), origin.stateId, target) ?? [];
                    for (const arc of arcs) {
                        if (arc.kind === 'move' || arc.kind === 'peel' || arc.kind === 'slip') addFlow(arc, (origin.meanPerMin * share) / variants.length, (origin.peakPerMin * share) / variants.length);
                    }
                }
            }
        }
    }

    /** Each destination's best (free-flow) next arcs - the one shortest way, whatever the variant. */
    const best = new Map([...freeFlow].map(([destId, { next }]) => [destId, next]));
    return { destinations, origins, variants, best, expectedMovementFlow, maxRoute, demandScale, assignment: assignmentReport };
}
