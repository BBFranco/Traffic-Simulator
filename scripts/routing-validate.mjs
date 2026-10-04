/**
 * routing-validate.mjs - Step 1 of destination routing: build the routing graph
 * from the engine and check it against the layout.
 *
 *   node scripts\routing-validate.mjs [--corridor=hatfield-realistic] [--detour=2.5] [--verbose]
 *
 * Read-only: builds the layout and engine in memory, prints a report, writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLayout } from '../resources/js/sim/corridor.js';
import { SimulationEngine } from '../resources/js/sim/engine.js';
import { resolveBlocks } from '../resources/js/sim/routing/blocks.js';
import { buildDriveways } from '../resources/js/sim/routing/driveways.js';
import { buildRoutingGraph, pathTo, shortestFrom } from '../resources/js/sim/routing/graph.js';
import { buildOdTable, followRoute } from '../resources/js/sim/routing/odTable.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const corridorId = args.corridor ?? 'hatfield-realistic';
const detourLimit = Number(args.detour ?? 2.5);
const verbose = 'verbose' in args;
/** Road ends this close together are one edge of the map (both directions of a two-way road). */
const EDGE_CLUSTER_M = 40;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'corridors', `${corridorId}.json`), 'utf8'));
const layout = buildLayout(config);
const engine = new SimulationEngine(layout);
const graph = buildRoutingGraph(engine);

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const heading = (title) => console.log(`\n== ${title} ==`);
const countBy = (items, key) => items.reduce((acc, item) => ((acc[key(item)] = (acc[key(item)] ?? 0) + 1), acc), {});

// 1. Counts
heading('Counts');
console.log('intersections:', graph.intersections.length, countBy(graph.intersections, (n) => n.control));
console.log('road directions:', graph.roads.size, '| states:', graph.states.size, '| arcs:', graph.arcs.length, countBy(graph.arcs, (a) => a.kind));
console.log('origins (spawning road directions):', graph.origins.length, '| exits (road ends out of the map):', graph.exits.length);

// 2. Node order vs geometry
heading('Node order vs geometry');
const orderIssues = [];
for (const arterial of layout.arterials) {
    arterial.intersections.forEach((node, i) => {
        const next = arterial.intersections[i + 1];
        if (!next) return;
        const ds = next.sAlongM - node.sAlongM;
        if (ds <= 0) orderIssues.push(`${arterial.id}: ${node.id} -> ${next.id} goes backwards (Δs ${ds.toFixed(1)} m)`);
        const written = config.arterials.find((a) => a.id === arterial.id).intersections[i].distanceToNextM;
        if (written != null && Math.abs(written - ds) > 1) orderIssues.push(`${arterial.id}: ${node.id} distanceToNextM ${written} but nodes are ${ds.toFixed(1)} m apart`);
        const straightM = dist(node.point, next.point);
        if (straightM > ds + 1) orderIssues.push(`${arterial.id}: ${node.id} -> ${next.id} ${straightM.toFixed(1)} m apart in a straight line, more than the ${ds.toFixed(1)} m along the road`);
    });
}
for (const connector of layout.connectors) {
    connector.nodeOffsetsM.forEach((offsetM, i) => {
        const nextM = connector.nodeOffsetsM[i + 1];
        if (nextM != null && nextM <= offsetM) orderIssues.push(`${connector.id}: ${connector.nodeIds[i]} -> ${connector.nodeIds[i + 1]} out of order (${offsetM.toFixed(1)} -> ${nextM.toFixed(1)} m)`);
    });
}
console.log(orderIssues.length ? orderIssues.join('\n') : 'none - every arterial and connector lists its nodes in driving order, matching the geometry');

// 3. Approaches with no legal movement
heading('Approaches with no legal way on');
const stuck = [];
for (const road of graph.roads.values()) {
    road.stops.forEach((stop, k) => {
        if (stop.type === 'gate' && stop.gate.approach && !(graph.arcsFrom.get(`${road.key}#${k}`) ?? []).length) stuck.push(`${road.key} at ${stop.gate.node.id}`);
    });
}
console.log(stuck.length ? stuck.join('\n') : 'none');
if (graph.anomalies.length) console.log('anomalies:\n' + graph.anomalies.join('\n'));

// 4. Edges of the map: spawn points and exits, clustered by place
heading('Edges of the map');
const ends = [
    ...graph.origins.map((o) => ({ point: o.point, roadKey: o.roadKey, enter: true })),
    ...graph.exits.map((e) => ({ point: e.point, roadKey: e.roadKey, exit: true })),
];
const edges = [];
for (const end of ends) {
    const edge = edges.find((e) => dist(e.point, end.point) <= EDGE_CLUSTER_M);
    if (edge) {
        edge.enter ||= Boolean(end.enter);
        edge.exit ||= Boolean(end.exit);
        edge.roads.push(`${end.roadKey}${end.enter ? ' (in)' : ' (out)'}`);
    } else {
        edges.push({ point: end.point, enter: Boolean(end.enter), exit: Boolean(end.exit), roads: [`${end.roadKey}${end.enter ? ' (in)' : ' (out)'}`] });
    }
}
edges.sort((a, b) => a.point.y - b.point.y || a.point.x - b.point.x);
console.log(`${edges.length} edges (Appendix B expects 24):`);
edges.forEach((edge, i) => {
    const allows = edge.enter && edge.exit ? 'enter + exit' : edge.enter ? 'enter only' : 'exit only';
    console.log(`  ${String(i + 1).padStart(2)}. (${edge.point.x.toFixed(0)}, ${edge.point.y.toFixed(0)})  ${allows.padEnd(12)}  ${edge.roads.join(', ')}`);
});

// 5. Reachability and detours
heading('Reachability');
const exitById = new Map(graph.exits.map((e) => [e.id, e]));
const reachedExits = new Set();
const detours = [];
let maxRoute = { timeS: 0 };
for (const origin of graph.origins) {
    const { dist: costs, prev } = shortestFrom(graph, origin.stateId);
    const reached = graph.exits.filter((e) => costs.has(e.id));
    reached.forEach((e) => reachedExits.add(e.id));
    const unreached = graph.exits.length - reached.length;
    if (verbose || unreached) console.log(`${origin.roadKey}: reaches ${reached.length}/${graph.exits.length} exits${unreached ? ` - not ${graph.exits.filter((e) => !costs.has(e.id)).map((e) => e.roadKey).join(', ')}` : ''}`);
    for (const exit of reached) {
        if (exit.roadKey === origin.roadKey) continue;
        const arcs = pathTo(prev, exit.id);
        const routeM = origin.firstRunM + arcs.reduce((s, a) => s + a.lengthM, 0);
        const timeS = origin.firstRunS + costs.get(exit.id);
        if (timeS > maxRoute.timeS) maxRoute = { timeS, from: origin.roadKey, to: exit.roadKey };
        const straightM = dist(origin.point, exitById.get(exit.id).point);
        if (straightM > 100 && routeM / straightM > detourLimit) detours.push({ from: origin.roadKey, to: exit.roadKey, routeM, straightM, ratio: routeM / straightM, arcs });
    }
}
const neverReached = graph.exits.filter((e) => !reachedExits.has(e.id));
console.log(neverReached.length ? `exits no origin reaches: ${neverReached.map((e) => e.roadKey).join(', ')}` : 'every exit is reachable from at least one origin');
console.log(`longest free-flow route (with junction penalties): ${maxRoute.timeS.toFixed(0)} s, ${maxRoute.from} -> ${maxRoute.to}`);

heading(`Origin-exit pairs with detour > ${detourLimit} (route / straight line, pairs over 100 m apart)`);
detours.sort((a, b) => b.ratio - a.ratio);
for (const d of detours) {
    console.log(`${d.ratio.toFixed(2)}  ${d.from} -> ${d.to}  (${d.routeM.toFixed(0)} m route, ${d.straightM.toFixed(0)} m apart)`);
    if (verbose) console.log('      via ' + d.arcs.filter((a) => a.kind === 'move' && a.movement !== 'straight' || ['peel', 'slip', 'join'].includes(a.kind)).map((a) => (a.kind === 'move' ? `${a.movement}@${a.nodeId}` : `${a.kind}->${a.to.split('#')[0]}`)).join(', '));
}
if (!detours.length) console.log('none');

// 6. Routing blocks
heading('Routing blocks');
if (!layout.routing) {
    console.log('no `routing` section in this corridor');
} else {
    console.log(`mode: ${layout.routing.mode} | ${layout.routing.blocks.length} block rows`);
    for (const warning of layout.routing.warnings) console.log('warning: ' + warning);
    const { blocks, problems } = resolveBlocks(graph, layout.routing);
    const dirCount = blocks.reduce((n, b) => n + b.dirs.length, 0);
    console.log(`${dirCount} block directions (destinations); one-way ${blocks.filter((b) => b.dirs.length === 1).length}, two-way ${blocks.filter((b) => b.dirs.length === 2).length}`);
    console.log(problems.length ? 'problems:\n' + problems.map((p) => '  ' + p).join('\n') : 'every block resolves, none passes through a junction');
    // 6b. Driveways
    const { driveways, dirs, handOffs } = buildDriveways(engine, graph, blocks, layout.routing);
    heading('Driveways');
    console.log(`${driveways.length} driveways; ${[...dirs.values()].filter((d) => d.reach.length).length}/${dirs.size} block directions can pull off`);
    const watch = ['PRO-2', 'SOU-1', 'HIL-7', 'GRO-7', 'DYR-1', 'DYR-2'];
    for (const b of blocks.filter((b) => verbose || watch.includes(b.id))) {
        const perDir = b.dirs.map((d) => {
            const reach = dirs.get(d.id).reach;
            return `${d.compass}: ${reach.filter((r) => r.side === 'left').length}L+${reach.filter((r) => r.side === 'right').length}R${reach.some((r) => r.crossesOncoming) ? ' (crossing)' : ''}`;
        });
        console.log(`  ${b.id.padEnd(7)} usable ${String(Math.round(b.usableM)).padStart(3)} of ${String(Math.round(b.lengthM)).padStart(3)} m   ${perDir.join('   ')}`);
    }
    console.log(handOffs.length ? 'no usable driveway - weight handed on:\n' + handOffs.map((h) => `  ${h.from} -> ${h.to ?? 'NOWHERE'} (${h.way}, weight ${h.weight.toFixed(0)})`).join('\n') : 'every block direction has a usable driveway');

    // 6c. OD table (Step 3)
    heading('OD table');
    const t0 = Date.now();
    const od = buildOdTable(graph, blocks, dirs, layout.routing, 1);
    console.log(`${od.destinations.length} destinations (${od.destinations.filter((d) => d.kind === 'exit').length} exits, ${od.destinations.filter((d) => d.kind === 'block').length} block directions), ${od.variants.length} route variants, built in ${Date.now() - t0} ms`);
    let worstSum = 0;
    for (const o of od.origins) {
        const sum = o.shares.reduce((s, x) => s + x.share, 0);
        worstSum = Math.max(worstSum, Math.abs(sum - 1));
        const through = o.shares.filter((x) => x.kind === 'exit').reduce((s, x) => s + x.share, 0);
        const top = [...o.shares].sort((a, b) => b.share - a.share).slice(0, 3).map((x) => `${x.destId} ${(x.share * 100).toFixed(1)}%`).join(', ');
        console.log(`  ${o.roadKey.padEnd(24)} ${o.scope.padEnd(8)} ${o.meanPerMin.toFixed(1).padStart(5)}/min  through ${(through * 100).toFixed(0).padStart(3)}%  ${String(o.shares.length).padStart(3)} dests, ${String(o.dropped.length).padStart(2)} dropped as detours  top: ${top}`);
    }
    console.log(`shares sum to 1 per origin: ${worstSum < 1e-9 ? 'yes' : `NO (worst off by ${worstSum})`}`);
    console.log(`longest route kept: ${od.maxRoute.timeS.toFixed(0)} s free-flow incl. junction penalties, ${od.maxRoute.from} -> ${od.maxRoute.to}`);
    const unrouted = od.origins.flatMap((o) => o.shares.filter((x) => od.variants.some((v) => !followRoute(v.get(x.destId), o.stateId, od.destinations.find((d) => d.id === x.destId).target))).map((x) => `${o.roadKey} -> ${x.destId}`));
    console.log(unrouted.length ? `pairs some variant can't route: ${unrouted.join(', ')}` : 'every variant routes every kept pair');
    if (verbose) {
        heading('Expected movement flow (veh/min, mean / peak)');
        for (const [key, moves] of [...od.expectedMovementFlow].sort()) {
            console.log(`  ${key.padEnd(48)} ${Object.entries(moves).map(([m, f]) => `${m} ${f.meanPerMin.toFixed(2)}/${f.peakPerMin.toFixed(2)}`).join('  ')}`);
        }
    }

    if (verbose) {
        heading('Blocks');
        for (const b of blocks) {
            const roads = [...new Set(b.dirs.flatMap((d) => d.pieces.map((p) => p.roadKey)))].join(' + ');
            console.log(`  ${b.id.padEnd(7)} ${b.dirs.map((d) => d.compass).join('/').padEnd(4)} ${b.lengthM.toFixed(1).padStart(6)} m  tier ${String(b.tier).padEnd(3)}${b.provisional ? '?' : ' '} weight ${b.weight.toFixed(0).padStart(5)}  ${roads}`);
        }
    }
}

// 7. Roundabout U-turns
heading('Roundabout U-turns');
const uTurns = graph.arcs.filter((a) => {
    if (a.kind !== 'move' || a.movement === 'straight') return false;
    const from = graph.states.get(a.from);
    const fromRoad = graph.roads.get(from.roadKey);
    const toRoad = graph.roads.get(graph.states.get(a.to)?.roadKey);
    return from.stop.gate.node.control === 'roundabout' && toRoad && toRoad.roadId === fromRoad.roadId && toRoad.dirKey !== fromRoad.dirKey;
});
console.log(uTurns.length ? `${uTurns.length} U-turn movements offered` : 'the engine offers no U-turn at any roundabout - needs a `uturn` movement before routes can use one (decision E1)');
