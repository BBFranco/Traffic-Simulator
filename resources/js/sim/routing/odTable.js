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
 */
import { roadPointAt } from '../corridor.js';
import { SeededRandom } from '../rng.js';
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
    const rng = new SeededRandom(seed);
    const variants = [];
    for (let v = 0; v < routing.routeVariants; v += 1) {
        const factor = new Map(graph.arcs.map((arc) => [arc, 1 + routing.routeCostNoise * (2 * rng.next() - 1)]));
        const costOf = (arc) => arc.costS * factor.get(arc);
        const next = new Map();
        for (const dest of destinations) next.set(dest.id, towards(graph, arcsTo, dest.target, costOf).next);
        variants.push(next);
    }
    // Free-flow (no noise) costs, for the destination choice and the detour check.
    const freeFlow = new Map(destinations.map((dest) => [dest.id, towards(graph, arcsTo, dest.target, (arc) => arc.costS)]));

    // Per origin: candidates, detour filter, shares.
    let maxRoute = { timeS: 0 };
    /** An origin's split over the destinations it can reach - `skip(dest)` leaves some out (its own road's exit, its own block). */
    const split = (origin, throughShare, skip) => {
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

        const exits = candidates.filter((c) => c.dest.kind === 'exit');
        const blockDests = candidates.filter((c) => c.dest.kind === 'block');
        const groupShare = { exit: exits.length ? (blockDests.length ? throughShare : 1) : 0 };
        groupShare.block = 1 - groupShare.exit;
        const shares = [];
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
        const { shares, dropped } = split(origin, throughShare, (dest) => dest.kind === 'exit' && dest.roadKey === origin.roadKey);
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

    return { destinations, origins, variants, expectedMovementFlow, maxRoute, demandScale };
}
