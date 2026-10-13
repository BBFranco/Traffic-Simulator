/**
 * How a user's saved layout (the Road Editor's and Simulator's copy) differs from the shared
 * template in `corridors/*.json` that batches run on. Edits made in the Road Editor never reach
 * the template on their own, so a batch can silently run on something other than what the editor
 * shows - the Results run modal and the Road Editor's Destinations section both say so.
 *
 * Key order doesn't count (MySQL's JSON column re-orders keys), and neither does `id`, which is
 * the layout's slug on one side and the file's id on the other.
 */

/**
 * @param saved     the user's layout config, as `corridors.show` returns it
 * @param template  the template config, as `corridor-templates.show` returns it
 * @returns {string[]} one short phrase per kind of difference - empty when they match
 */
export function describeLayoutDrift(saved, template) {
    const parts = [];

    const savedBlocks = new Map((saved.routing?.blocks ?? []).map((block) => [block.id, block]));
    const templateBlocks = new Map((template.routing?.blocks ?? []).map((block) => [block.id, block]));
    let retiered = 0;
    let reshaped = 0;
    for (const [id, block] of savedBlocks) {
        const other = templateBlocks.get(id);
        if (!other) continue;
        if (block.from !== other.from || block.to !== other.to) reshaped += 1;
        else if (!sameValue(block, other)) retiered += 1;
    }
    const onlySaved = [...savedBlocks.keys()].filter((id) => !templateBlocks.has(id)).length;
    const onlyTemplate = [...templateBlocks.keys()].filter((id) => !savedBlocks.has(id)).length;
    if (retiered) parts.push(`${retiered} block tier${plural(retiered)}`);
    if (onlySaved) parts.push(`${onlySaved} block${plural(onlySaved)} only in your layout`);
    if (onlyTemplate) parts.push(`${onlyTemplate} block${plural(onlyTemplate)} only in the template`);
    if (reshaped) parts.push(`${reshaped} block${plural(reshaped)} with other ends`);

    const routingKeys = keysOf(saved.routing, template.routing).filter((key) => key !== 'blocks');
    const routingSettings = routingKeys.filter((key) => !sameValue(saved.routing?.[key], template.routing?.[key]));
    if (routingSettings.length) parts.push(`routing settings (${routingSettings.join(', ')})`);

    const sections = keysOf(saved, template).filter((key) => key !== 'id' && key !== 'routing' && !sameValue(saved[key], template[key]));
    if (sections.length) parts.push(`layout (${sections.join(', ')})`);

    return parts;
}

function keysOf(a, b) {
    return [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
}

function plural(count) {
    return count === 1 ? '' : 's';
}

/** Deep equality that ignores object key order. */
function sameValue(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((value, i) => sameValue(value, b[i]));
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}
