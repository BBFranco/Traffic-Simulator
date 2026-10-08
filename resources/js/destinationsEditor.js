/**
 * The Road Editor's Destinations section: destination routing's blocks
 * (corridor.js's `routing.blocks`). On the whole-corridor map every block is
 * drawn along its road in its tier's colour (BLOCK_TIER_COLOURS), with a
 * legend; clicking one opens a picker right there to change its tier or remove
 * it. Stretches that could be destinations but aren't yet - the inlets from
 * the map edge, any stretch no block covers (routing/candidates.js) - are drawn
 * dashed, and clicking one adds it at the tier picked. The side panel lists the
 * blocks by road. Every edit previews straight away - the colours, driveway
 * counts and driveways on the map are rebuilt from the layout with the unsaved
 * edits - and Save writes them into the user's layout (CorridorRoutingTierController).
 */
import { buildLayout, roadPointAt } from './sim/corridor.js';
import { SimulationEngine } from './sim/engine.js';
import { candidateBlocks } from './sim/routing/candidates.js';
import { BLOCK_TIERS, BLOCK_TIER_COLOURS } from './sim/routing/config.js';
import { buildRoutingModel } from './sim/routing/model.js';

/** How finely a block's line follows its road (m). */
const OUTLINE_STEP_M = 5;
/** How close a click has to be to a block's line to pick it (px). */
const HIT_RADIUS_PX = 10;
/** The picker's gap from the clicked point, and from the canvas edges (px). */
const PICKER_OFFSET_PX = 12;
const PICKER_MARGIN_PX = 8;

export function createDestinationsEditor({ boot, renderer, getCorridorConfig, getCorridorLayout, getCorridorId, corridorDescriptor, isOverview, onSaved }) {
    const el = {
        list: document.getElementById('editor-destinations'),
        status: document.getElementById('destinations-status'),
        save: document.getElementById('destinations-save'),
        discard: document.getElementById('destinations-discard'),
        legend: document.getElementById('editor-tier-legend'),
        picker: document.getElementById('editor-tier-picker'),
    };

    /** Unsaved edits: a new tier per existing block id, blocks added (by id), blocks removed. */
    const pendingTiers = new Map();
    const added = new Map();
    const removed = new Set();
    let model = null;
    let candidates = [];
    /** Each block's (and candidate's) line(s) along its road - built with the model. */
    let outlines = new Map();
    /** What's picked: `{ kind: 'block' | 'candidate', id }`, or null. */
    let selected = null;
    let isBusy = false;

    const dirtyCount = () => pendingTiers.size + added.size + removed.size;

    /** The routing model for the corridor with the unsaved edits laid over it - null for a layout without routing. */
    function rebuildModel() {
        const config = getCorridorConfig();
        if (!config?.routing) {
            model = null;
            candidates = [];
            outlines = new Map();
            return;
        }
        const preview = structuredClone(config);
        preview.routing.blocks = [
            ...preview.routing.blocks.filter((block) => !removed.has(block.id)).map((block) => (pendingTiers.has(block.id) ? { ...block, tier: pendingTiers.get(block.id) } : block)),
            ...added.values(),
        ];
        const engine = new SimulationEngine(buildLayout(preview));
        model = buildRoutingModel(engine);
        candidates = candidateBlocks(engine.layout, model.graph, model.blocks).map((candidate) => ({ ...candidate, key: `${candidate.from}|${candidate.to}` }));
        outlines = new Map([...model.blocks.map((block) => [block.id, outlineOf(block)]), ...candidates.map((c) => [c.key, outlineOf(c)])]);
    }

    function roadName(roadKey) {
        const { roadId } = model.graph.roads.get(roadKey);
        const layout = getCorridorLayout();
        const road = layout.arterials.find((a) => a.id === roadId) ?? layout.connectors.find((c) => c.id === roadId);
        return road?.name ?? roadId;
    }

    const blockById = (id) => model?.blocks.find((block) => block.id === id) ?? null;
    const candidateByKey = (key) => candidates.find((c) => c.key === key) ?? null;
    const savedBlock = (id) => getCorridorConfig().routing.blocks.find((block) => block.id === id) ?? null;

    function outlineOf(block) {
        return block.dirs.slice(0, 1).flatMap((dir) =>
            dir.pieces.map((piece) => {
                const road = model.graph.roads.get(piece.roadKey).road;
                const points = [];
                for (let atM = piece.fromM; atM < piece.toM; atM += OUTLINE_STEP_M) points.push(roadPointAt(road, atM).point);
                points.push(roadPointAt(road, piece.toM).point);
                return points;
            })
        );
    }

    /** A free id for a new block on road `roadId`: the prefix its existing blocks use (else one from the road's name) and the next number. */
    function newBlockId(roadId) {
        const onRoad = model.blocks.filter((block) => block.dirs.some((dir) => model.graph.roads.get(dir.pieces[0].roadKey).roadId === roadId));
        const prefix = onRoad[0]?.id.replace(/-[^-]*$/, '') ?? roadId.replace(/^conn_/, '').slice(0, 3).toUpperCase();
        const taken = new Set([...getCorridorConfig().routing.blocks.map((b) => b.id), ...added.keys()]);
        let n = 1;
        while (taken.has(`${prefix}-${n}`)) n += 1;
        return `${prefix}-${n}`;
    }

    /** Every block in its tier's colour, the candidates dashed, and the driveways - only on the whole-corridor map, which is the layout they belong to. */
    function drawMap() {
        const showMap = isOverview() && model;
        el.legend.classList.toggle('hidden', !showMap);
        if (!showMap) closePicker();
        renderer.setDriveways(showMap ? model.driveways : null);
        const selectedBlockId = selected?.kind === 'block' ? selected.id : null;
        renderer.setRoutingTiers(
            showMap
                ? {
                      blocks: model.blocks.map((block) => ({
                          id: block.id,
                          lines: outlines.get(block.id),
                          colour: BLOCK_TIER_COLOURS[block.tier].fill,
                          textColour: BLOCK_TIER_COLOURS[block.tier].text,
                          label: `${block.id} · ${block.tier}`,
                      })),
                      selectedId: selectedBlockId,
                      selectedDriveways: model.driveways.filter((w) => w.blockId === selectedBlockId),
                      candidates: candidates.map((c) => ({ key: c.key, lines: outlines.get(c.key) })),
                      selectedCandidate: selected?.kind === 'candidate' ? selected.id : null,
                  }
                : null
        );
    }

    function swatch(tier) {
        const dot = document.createElement('span');
        dot.className = 'inline-block h-2.5 w-2.5 shrink-0 rounded-full';
        dot.style.backgroundColor = BLOCK_TIER_COLOURS[tier].fill;
        return dot;
    }

    function renderLegend() {
        const title = document.createElement('div');
        title.className = 'mb-1 font-semibold uppercase tracking-wider text-slate-500';
        title.textContent = 'Destination tiers';
        const rows = BLOCK_TIERS.map((tier) => {
            const row = document.createElement('div');
            row.className = 'flex items-center gap-1.5';
            row.append(swatch(tier), `Tier ${tier}`);
            return row;
        });
        const dashed = document.createElement('div');
        dashed.className = 'mt-1 flex items-center gap-1.5';
        const dash = document.createElement('span');
        dash.className = 'inline-block w-2.5 shrink-0 border-t-2 border-dashed border-slate-400';
        dashed.append(dash, 'Not a destination yet');
        el.legend.replaceChildren(title, ...rows, dashed);
    }

    /** Re-preview after any edit and redraw the panel, the map and the open picker. */
    function changed() {
        rebuildModel();
        if (selected?.kind === 'block' && !blockById(selected.id)) selected = null;
        if (selected?.kind === 'candidate' && !candidateByKey(selected.id)) selected = null;
        render();
        drawMap();
        if (selected) fillPicker();
        else closePicker();
    }

    function setTier(id, tier) {
        if (added.has(id)) added.set(id, { ...added.get(id), tier });
        else if (tier === savedBlock(id).tier) pendingTiers.delete(id);
        else pendingTiers.set(id, tier);
        changed();
    }

    function addBlock(candidate, tier) {
        const id = newBlockId(candidate.roadId);
        added.set(id, { id, from: candidate.from, to: candidate.to, tier });
        selected = { kind: 'block', id };
        changed();
    }

    function removeBlock(id) {
        if (added.has(id)) added.delete(id);
        else {
            removed.add(id);
            pendingTiers.delete(id);
        }
        selected = null;
        changed();
    }

    function pickerHeader(text, detailText) {
        const title = document.createElement('div');
        title.className = 'mb-1.5 flex items-center justify-between gap-2';
        const name = document.createElement('span');
        name.className = 'font-semibold text-slate-900 dark:text-slate-100';
        name.textContent = text;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'rounded px-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800';
        close.textContent = '×';
        close.title = 'Close';
        close.addEventListener('click', () => select(null));
        title.append(name, close);
        const detail = document.createElement('div');
        detail.className = 'mb-1.5 text-[10px] text-slate-500';
        detail.textContent = detailText;
        return [title, detail];
    }

    function tierButtons(current, onPick) {
        return BLOCK_TIERS.map((tier) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.active = tier === current ? 'true' : 'false';
            button.className =
                'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-slate-700 transition hover:bg-slate-100 ' +
                'data-[active=true]:bg-slate-100 data-[active=true]:font-semibold dark:text-slate-300 dark:hover:bg-slate-800 dark:data-[active=true]:bg-slate-800';
            button.append(swatch(tier), `Tier ${tier}`);
            button.addEventListener('click', () => onPick(tier));
            return button;
        });
    }

    /** The picker for what's selected: a block's tiers and a remove button, or a candidate's "add at tier". */
    function fillPicker() {
        if (selected.kind === 'candidate') {
            const candidate = candidateByKey(selected.id);
            const hint = document.createElement('div');
            hint.className = 'mb-1 text-[10px] text-slate-500';
            hint.textContent = 'Add as a destination at:';
            el.picker.replaceChildren(
                ...pickerHeader('New destination', `${roadName(candidate.dirs[0].pieces[0].roadKey)} · ${Math.round(candidate.lengthM)} m`),
                hint,
                ...tierButtons(null, (tier) => addBlock(candidate, tier))
            );
            return;
        }
        const block = blockById(selected.id);
        const perSide = ['A', 'B'].map((side) => model.driveways.filter((w) => w.blockId === block.id && w.side === side).length);
        const state = added.has(block.id) ? ' · new, unsaved' : pendingTiers.has(block.id) ? ' · unsaved' : '';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'mt-1.5 w-full rounded border border-rose-300 px-1.5 py-1 text-left text-rose-700 transition hover:bg-rose-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10';
        remove.textContent = added.has(block.id) ? 'Undo add' : 'Remove destination';
        remove.addEventListener('click', () => removeBlock(block.id));
        el.picker.replaceChildren(
            ...pickerHeader(block.id, `${roadName(block.dirs[0].pieces[0].roadKey)} · ${perSide[0]} + ${perSide[1]} driveways${state}`),
            ...tierButtons(block.tier, (tier) => setTier(block.id, tier)),
            remove
        );
    }

    /** Opens the picker beside screen point `local`, kept inside the canvas. */
    function openPicker(local) {
        fillPicker();
        el.picker.classList.remove('hidden');
        const area = el.picker.parentElement.getBoundingClientRect();
        const box = el.picker.getBoundingClientRect();
        el.picker.style.left = `${Math.max(PICKER_MARGIN_PX, Math.min(local.x + PICKER_OFFSET_PX, area.width - box.width - PICKER_MARGIN_PX))}px`;
        el.picker.style.top = `${Math.max(PICKER_MARGIN_PX, Math.min(local.y + PICKER_OFFSET_PX, area.height - box.height - PICKER_MARGIN_PX))}px`;
    }

    function closePicker() {
        el.picker.classList.add('hidden');
    }

    /** Picks `hit` (`{ kind, id }`, or null to clear) - from the list, or from the map at `local`, where the picker opens. */
    function select(hit, local = null) {
        selected = hit;
        render();
        drawMap();
        if (hit && local) openPicker(local);
        else closePicker();
        if (hit?.kind === 'block') el.list.querySelector(`[data-block-id="${CSS.escape(hit.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    }

    function tierSelect(block) {
        const select = document.createElement('select');
        select.className = 'rounded border-slate-300 bg-white py-0.5 pl-1.5 pr-6 text-[11px] text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';
        for (const tier of BLOCK_TIERS) {
            const option = document.createElement('option');
            option.value = String(tier);
            option.textContent = `Tier ${tier}`;
            option.selected = tier === block.tier;
            select.append(option);
        }
        select.addEventListener('click', (event) => event.stopPropagation());
        select.addEventListener('change', () => setTier(block.id, Number(select.value)));
        return select;
    }

    function badge(text, className) {
        const span = document.createElement('span');
        span.className = `shrink-0 rounded px-1 text-[9px] ${className}`;
        span.textContent = text;
        return span;
    }

    function blockRow(block) {
        const row = document.createElement('div');
        row.dataset.blockId = block.id;
        row.dataset.active = selected?.kind === 'block' && block.id === selected.id ? 'true' : 'false';
        row.dataset.dirty = pendingTiers.has(block.id) || added.has(block.id) ? 'true' : 'false';
        row.className =
            'flex cursor-pointer items-center justify-between gap-2 rounded-md border px-2 py-1 text-[11px] transition ' +
            'border-slate-200 bg-white text-slate-700 hover:border-slate-300 ' +
            'data-[active=true]:border-sky-500 data-[active=true]:bg-sky-50 data-[dirty=true]:border-amber-400 ' +
            'dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:data-[active=true]:border-sky-400 dark:data-[active=true]:bg-sky-500/10';

        const name = document.createElement('span');
        name.className = 'min-w-0 flex-1 truncate';
        name.textContent = block.id;
        const count = document.createElement('span');
        count.className = 'shrink-0 font-mono text-[10px] text-slate-500';
        const perSide = ['A', 'B'].map((side) => model.driveways.filter((w) => w.blockId === block.id && w.side === side).length);
        count.textContent = `${perSide[0]} + ${perSide[1]}`;
        count.title = 'Driveways on each side of the block';
        row.append(swatch(block.tier), name);
        if (added.has(block.id)) row.append(badge('new', 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'));
        else if (block.provisional && !pendingTiers.has(block.id)) row.append(badge('provisional', 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'));
        row.append(count, tierSelect(block));
        row.addEventListener('click', () => select(row.dataset.active === 'true' ? null : { kind: 'block', id: block.id }));
        return row;
    }

    function statusLine() {
        if (dirtyCount()) {
            const parts = [
                pendingTiers.size && `${pendingTiers.size} tier change${pendingTiers.size === 1 ? '' : 's'}`,
                added.size && `${added.size} added`,
                removed.size && `${removed.size} removed`,
            ].filter(Boolean);
            return `Unsaved: ${parts.join(', ')}`;
        }
        return `Click a coloured block on the map to change its tier, or a dashed stretch (${candidates.length} left) to add a destination`;
    }

    function render(statusText = null) {
        el.save.disabled = isBusy || !dirtyCount();
        el.discard.disabled = isBusy || !dirtyCount();

        if (!model) {
            el.status.textContent = '';
            const note = document.createElement('p');
            note.className = 'text-[11px] text-slate-500';
            note.textContent = 'This layout has no routing section, so it has no destination blocks.';
            el.list.replaceChildren(note);
            el.save.disabled = true;
            el.discard.disabled = true;
            return;
        }
        el.status.textContent = statusText ?? statusLine();

        const byRoad = new Map();
        for (const block of model.blocks) {
            const road = block.dirs.length ? roadName(block.dirs[0].pieces[0].roadKey) : 'Unresolved';
            if (!byRoad.has(road)) byRoad.set(road, []);
            byRoad.get(road).push(block);
        }
        el.list.replaceChildren(
            ...[...byRoad].map(([road, blocks]) => {
                const group = document.createElement('div');
                group.className = 'space-y-1';
                const heading = document.createElement('div');
                heading.className = 'text-[10px] font-semibold uppercase tracking-wider text-slate-500';
                heading.textContent = road;
                group.append(heading, ...blocks.map(blockRow));
                return group;
            })
        );
    }

    async function save() {
        const body = {};
        if (pendingTiers.size) body.tiers = [...pendingTiers].map(([id, tier]) => ({ id, tier }));
        if (added.size) body.add = [...added.values()];
        if (removed.size) body.remove = [...removed];
        isBusy = true;
        render('Saving…');
        try {
            const response = await fetch(boot.routingTiersUrlTemplate.replace('__ID__', encodeURIComponent(getCorridorId())), {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content ?? '',
                },
                body: JSON.stringify(body),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
            const count = dirtyCount();
            if (corridorDescriptor()) corridorDescriptor().hasEdits = payload.hasEdits;
            isBusy = false;
            await onSaved();
            corridorLoaded();
            render(`Saved ${count} change${count === 1 ? '' : 's'} to your layout`);
        } catch (error) {
            isBusy = false;
            render(`Save failed: ${error.message}`);
        }
    }

    function discard() {
        pendingTiers.clear();
        added.clear();
        removed.clear();
        changed();
        render('Unsaved destination changes discarded');
    }

    /** A fresh corridor (loaded, saved or reverted): unsaved edits go with the old one, and the selection if it went too. */
    function corridorLoaded() {
        pendingTiers.clear();
        added.clear();
        removed.clear();
        changed();
    }

    /** The block or candidate whose line passes within HIT_RADIUS_PX of screen point `local` - `{ kind, id }` - or null. Blocks win a tie. */
    function hitTest(local) {
        if (!model) return null;
        let best = null;
        const blockIds = new Set(model.blocks.map((block) => block.id));
        for (const [id, lines] of outlines) {
            for (const line of lines) {
                for (const point of line) {
                    const p = renderer.camera.toScreen(point);
                    const d = Math.hypot(p.x - local.x, p.y - local.y) - (blockIds.has(id) ? 0.5 : 0);
                    if (d <= HIT_RADIUS_PX && (!best || d < best.d)) best = { id, d };
                }
            }
        }
        if (!best) return null;
        return { kind: blockIds.has(best.id) ? 'block' : 'candidate', id: best.id };
    }

    /** What the map tooltip says about `hit`. */
    function describe(hit) {
        if (hit.kind === 'candidate') {
            const candidate = candidateByKey(hit.id);
            return { title: `${roadName(candidate.dirs[0].pieces[0].roadKey)} · not a destination yet`, action: 'Click to add it as a destination' };
        }
        const block = blockById(hit.id);
        return { title: `${block.id} · tier ${block.tier}${pendingTiers.has(hit.id) || added.has(hit.id) ? ' (unsaved)' : ''}`, action: 'Click to change its tier or remove it' };
    }

    el.save.addEventListener('click', save);
    el.discard.addEventListener('click', discard);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closePicker();
    });
    renderLegend();

    return {
        corridorLoaded,
        /** The view switched between the whole corridor and one intersection. */
        modeChanged: drawMap,
        hitTest,
        select,
        describe,
        closePicker,
        get dirtyCount() {
            return dirtyCount();
        },
    };
}
