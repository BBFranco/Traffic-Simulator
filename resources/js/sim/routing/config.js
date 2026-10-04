/**
 * routing/config.js - the corridor's optional `routing` section, parsed and
 * checked against the layout's own ids.
 *
 * `routing.mode` picks how cars choose their way: "random" (the turn chances,
 * as before destination routing existed) or "destination" (each car gets an
 * origin-destination trip and follows a route to it). Everything else is the
 * destination model's inputs:
 *
 *   blocks[]  - `{ id, from, to, tier, provisional?, weightShare? }`: the
 *               stretch of road between two points that cars may pull off
 *               into. A point is an intersection id, or `<road id>:start` /
 *               `<road id>:end` for a road's own ends (an arterial's or
 *               connector's, in its own direction of definition). Which
 *               directions a block runs in, and its length, come from the
 *               routing graph (routing/blocks.js), not from here.
 *   tier      - destination density, 1.5 (lower-medium) to 5 (very high).
 *   provisional - a tier not taken from the density survey yet; the loader
 *               lists these so they don't get forgotten.
 *   weightShare - fraction of the tier x length weight this row carries (0.5
 *               for each carriageway of a road surveyed as one row).
 */
export const ROUTING_MODES = ['random', 'destination'];
export const BLOCK_TIERS = [1.5, 2, 3, 4, 5];

const DEFAULTS = {
    mode: 'random',
    throughShare: { arterial: 0.6, side: 0.3 },
    decayPerSecond: 0.002,
    routeVariants: 5,
    routeCostNoise: 0.1,
    detourLimit: 2.5,
    nodePenaltyS: { signal: 20, roundabout: 5, allWayStop: 8, stop: 8 },
    turnPenaltyS: { left: 0, right: 0 },
    crossableMedianRoads: [],
};

/**
 * @param raw        the config's `routing` value (may be absent)
 * @param nodesById  the layout's intersections
 * @param roadIds    every arterial and connector id in the layout
 * @returns the parsed routing section, or null when the config has none;
 *          `warnings` lists the provisional blocks
 */
export function parseRouting(raw, nodesById, roadIds) {
    if (raw == null) return null;
    if (typeof raw !== 'object') throw new Error('`routing` must be an object.');

    const mode = raw.mode ?? DEFAULTS.mode;
    if (!ROUTING_MODES.includes(mode)) throw new Error(`routing.mode "${mode}" - use ${ROUTING_MODES.join(' or ')}.`);

    const checkPoint = (point, label) => {
        if (typeof point !== 'string') throw new Error(`${label} must be an intersection id or "<road id>:start|end".`);
        if (nodesById.has(point)) return;
        const [roadId, end, ...rest] = point.split(':');
        if (rest.length || !['start', 'end'].includes(end)) throw new Error(`${label} "${point}" is not an intersection id or "<road id>:start|end".`);
        if (!roadIds.has(roadId)) throw new Error(`${label} "${point}": no road "${roadId}".`);
    };

    const seen = new Set();
    const blocks = (raw.blocks ?? []).map((block, i) => {
        const label = `routing.blocks[${i}]${block?.id ? ` "${block.id}"` : ''}`;
        if (!block?.id) throw new Error(`${label} needs an id.`);
        if (seen.has(block.id)) throw new Error(`${label}: duplicate block id.`);
        seen.add(block.id);
        checkPoint(block.from, `${label}.from`);
        checkPoint(block.to, `${label}.to`);
        if (block.from === block.to) throw new Error(`${label}: from and to are the same point.`);
        if (!BLOCK_TIERS.includes(block.tier)) throw new Error(`${label}: tier ${block.tier} - use one of ${BLOCK_TIERS.join(', ')}.`);
        const weightShare = block.weightShare ?? 1;
        if (!(weightShare > 0 && weightShare <= 1)) throw new Error(`${label}: weightShare must be in (0, 1].`);
        return { id: block.id, from: block.from, to: block.to, tier: block.tier, provisional: Boolean(block.provisional), weightShare };
    });

    for (const roadId of raw.crossableMedianRoads ?? []) {
        if (!roadIds.has(roadId)) throw new Error(`routing.crossableMedianRoads: no road "${roadId}".`);
    }

    const provisional = blocks.filter((block) => block.provisional);
    return {
        ...DEFAULTS,
        ...raw,
        mode,
        throughShare: { ...DEFAULTS.throughShare, ...(raw.throughShare ?? {}) },
        nodePenaltyS: { ...DEFAULTS.nodePenaltyS, ...(raw.nodePenaltyS ?? {}) },
        turnPenaltyS: { ...DEFAULTS.turnPenaltyS, ...(raw.turnPenaltyS ?? {}) },
        crossableMedianRoads: raw.crossableMedianRoads ?? [],
        blocks,
        warnings: provisional.length ? [`Provisional block tiers (tier ${provisional.map((b) => b.tier).join('/')} until surveyed): ${provisional.map((b) => b.id).join(', ')}`] : [],
    };
}
