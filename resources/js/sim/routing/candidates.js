/**
 * routing/candidates.js - the stretches of road that could be routing blocks
 * but aren't: the inlets between a road's end at the map edge and its first
 * junction, and any stretch between two junctions no block covers yet. The
 * Road Editor offers them as "add a destination here".
 *
 * A candidate is a pair of neighbouring points along one config road, in the
 * same `{ from, to }` form a block uses (an intersection id, or
 * `<road id>:start|end`). It is only offered if it resolves on the routing
 * graph like a block would (routing/blocks.js), runs through no junction,
 * overlaps no existing block and is long enough to hold a driveway.
 */
import { resolveBlocks } from './blocks.js';

/** Shorter than this (m) and a stretch can't hold a driveway clear of its ends. */
const MIN_CANDIDATE_M = 60;

/** Neighbouring points along each arterial and connector, in its own direction of definition. */
function neighbourPairs(layout) {
    const pairs = [];
    const along = (roadId, nodeIds) => {
        const points = [`${roadId}:start`, ...nodeIds, `${roadId}:end`];
        for (let i = 0; i < points.length - 1; i += 1) pairs.push({ roadId, from: points[i], to: points[i + 1] });
    };
    for (const arterial of layout.arterials) along(arterial.id, arterial.intersections.map((node) => node.id));
    for (const connector of layout.connectors) along(connector.id, connector.nodeIds);
    return pairs;
}

function overlaps(a, b) {
    return a.roadKey === b.roadKey && Math.min(a.toM, b.toM) - Math.max(a.fromM, b.fromM) > 1;
}

/**
 * @param layout   buildLayout()'s layout
 * @param graph    routing/graph.js's graph for it
 * @param blocks   routing/blocks.js's resolved blocks (the existing ones)
 * @returns `[{ roadId, from, to, lengthM, dirs }]` - each with its resolved directions, for drawing
 */
export function candidateBlocks(layout, graph, blocks) {
    const taken = new Set(blocks.flatMap((block) => [`${block.from}|${block.to}`, `${block.to}|${block.from}`]));
    const existingPieces = blocks.flatMap((block) => block.dirs.flatMap((dir) => dir.pieces));
    const pairs = neighbourPairs(layout).filter((pair) => pair.from !== pair.to && !taken.has(`${pair.from}|${pair.to}`));
    const { blocks: resolved } = resolveBlocks(graph, { blocks: pairs.map((pair, i) => ({ ...pair, id: `candidate-${i}`, tier: 1, weightShare: 1 })) });
    return resolved
        .filter((block) => block.dirs.length && block.lengthM >= MIN_CANDIDATE_M && block.dirs.every((dir) => !dir.via.length))
        .filter((block) => !block.dirs.some((dir) => dir.pieces.some((piece) => existingPieces.some((other) => overlaps(piece, other)))))
        .map((block) => ({ roadId: block.roadId, from: block.from, to: block.to, lengthM: block.lengthM, dirs: block.dirs }));
}
