/**
 * Lane-arrow editor on a 2D map (the Road editor page). While it's open, every
 * painted lane arrow on an approach with more than one lane is clickable (and
 * every turn lane's): a click steps that lane to its next lane-use marking, a
 * right-click to the previous one. Edits apply to the running simulation
 * straight away (the engine reads each approach's `laneUse` live). Turn lanes
 * themselves are added and removed on the page (roadEditor.js), which rebuilds
 * the layout; this module tracks them for Save/Discard like the arrows. Save
 * writes both into the user's own layout, Discard puts back the last saved
 * state, and Revert to original puts the layout back as it was imported.
 */
import { LANE_USE_OPTIONS, TURN_LANE_SIDES, laneMovesOf, laneUseToken, turnLanesToConfig } from './sim/corridor.js';

const MOVEMENT_LABELS = { left: 'left', straight: 'straight', right: 'right' };
const TURN_LANE_LABELS = { left: 'left turn lane', right: 'right turn lane' };
/** A pointer that moves further than this between down and up was a pan, not a click. */
const CLICK_SLOP_PX = 5;

const movesFromToken = (token) => (token === 'all' ? ['left', 'straight', 'right'] : token.split('_'));

/** One side's turn lane as a comparable string - '' for none. */
const turnLaneKey = (turnLane) => (turnLane ? `${turnLane.lengthM}|${turnLane.laneUse}` : '');

export function createLaneEditor({ canvas, tooltip, renderer, boot, getLayout, getEngine, getCorridorId, reloadCorridor, rebuildLayout, onSaved = () => {}, onChange = () => {}, logChange = () => {} }) {
    const el = {
        status: document.getElementById('lane-edit-status'),
        save: document.getElementById('lane-edit-save'),
        discard: document.getElementById('lane-edit-discard'),
        revert: document.getElementById('lane-edit-revert'),
    };

    let isOpen = false;
    let isBusy = false;
    /** approach.id -> `{ lanes, turnLanes }` as last loaded/saved, in corridor JSON form - what "unsaved" is measured against. */
    let saved = new Map();
    let pointerDownAt = null;

    function approaches() {
        const layout = getLayout();
        if (!layout) return [];
        return layout.arterials.flatMap((arterial) => arterial.intersections.flatMap((node) => node.approaches.filter((a) => a.laneUse)));
    }

    function snapshotOf(approach) {
        return { lanes: approach.laneUse.map(laneUseToken), turnLanes: turnLanesToConfig(approach.turnLanes) };
    }

    function isTurnLaneDirty(approach, side) {
        return turnLaneKey(saved.get(approach.id)?.turnLanes?.[side]) !== turnLaneKey(snapshotOf(approach).turnLanes?.[side]);
    }

    /** `lane` is a lane index, or 'left'/'right' for a turn lane. */
    function isDirty(approach, lane) {
        if (typeof lane === 'string') return isTurnLaneDirty(approach, lane);
        return saved.get(approach.id)?.lanes[lane] !== laneUseToken(approach.laneUse[lane]);
    }

    function dirtyApproaches() {
        return approaches().filter(
            (approach) => approach.laneUse.some((_, lane) => isDirty(approach, lane)) || TURN_LANE_SIDES.some((side) => isTurnLaneDirty(approach, side))
        );
    }

    function corridorDescriptor() {
        return boot.corridors?.find((c) => c.id === getCorridorId()) ?? null;
    }

    function laneUseUrl() {
        return boot.laneUseUrlTemplate.replace('__ID__', encodeURIComponent(getCorridorId()));
    }

    function render(message = null) {
        const dirtyCount = dirtyApproaches().length;
        el.save.disabled = isBusy || !dirtyCount;
        el.discard.disabled = isBusy || !dirtyCount;
        el.revert.disabled = isBusy || !corridorDescriptor()?.hasEdits;
        el.status.textContent =
            message ??
            (dirtyCount
                ? `${dirtyCount} approach${dirtyCount === 1 ? '' : 'es'} changed - not saved yet`
                : isOpen
                  ? 'Click an arrow to change it · right-click steps back'
                  : 'Pick an intersection to change its arrows');
        onChange(dirtyCount);
    }

    /** Markings `lane` can take - only movements its junction actually offers (engine.movementsAt()); a turn lane never goes straight. */
    function optionsFor(approach, lane) {
        const possible = getEngine().movementsAt(approach);
        return LANE_USE_OPTIONS.filter((moves) => moves.every((m) => possible.includes(m)) && (typeof lane === 'number' || !moves.includes('straight')));
    }

    /** Steps one lane's marking forward/back, skipping any that would leave the approach with no straight-ahead lane. */
    function cycle(approach, lane, step) {
        const options = optionsFor(approach, lane);
        if (!options.length) return;
        const moves = laneMovesOf(approach, lane);
        const current = options.findIndex((option) => laneUseToken(option) === laneUseToken(moves));
        const othersAllowStraight = typeof lane === 'string' || approach.laneUse.some((other, i) => i !== lane && other.includes('straight'));

        for (let n = 1; n <= options.length; n += 1) {
            const next = options[(((current === -1 ? 0 : current) + step * n) % options.length + options.length) % options.length];
            if (!othersAllowStraight && !next.includes('straight')) continue;
            // In place - the engine's per-slot lane use shares these arrays.
            moves.splice(0, moves.length, ...next);
            break;
        }

        renderer.refreshLaneArrows();
        logChange('lane-use', `${approach.id} ${typeof lane === 'string' ? `${lane} turn lane` : `lane ${lane + 1}`} -> ${laneUseToken(moves)}`);
        render();
        showTip(approach, lane);
    }

    function laneName(approach, lane) {
        if (typeof lane === 'string') return TURN_LANE_LABELS[lane];
        if (lane === 0) return 'kerb lane';
        return lane === approach.lanes - 1 ? 'median lane' : `lane ${lane + 1}`;
    }

    function describe(approach, lane) {
        const layout = getLayout();
        const node = layout.nodesById.get(approach.nodeId);
        const where = approach.laneUseKey === 'arterial' ? approach.label : `${approach.label} ${approach.laneUseKey}`;
        const moves = laneMovesOf(approach, lane)
            .map((m) => MOVEMENT_LABELS[m])
            .join(' + ');
        return { title: `${where} · ${laneName(approach, lane)}`, node: node?.name ?? approach.nodeId, moves };
    }

    function showTip(approach, lane, local = null) {
        const { title, node, moves } = describe(approach, lane);
        tooltip.replaceChildren();
        const heading = document.createElement('div');
        heading.className = 'font-semibold text-slate-900 dark:text-slate-100';
        heading.textContent = title;
        const at = document.createElement('div');
        at.className = 'text-slate-500 dark:text-slate-400';
        at.textContent = node;
        const value = document.createElement('div');
        value.className = `mt-1 ${isDirty(approach, lane) ? 'text-amber-600 dark:text-amber-400' : 'text-sky-700 dark:text-sky-300'}`;
        value.textContent = isDirty(approach, lane) ? `${moves} (unsaved)` : moves;
        tooltip.append(heading, at, value);
        tooltip.classList.remove('hidden');

        if (!local) return;
        const rect = canvas.getBoundingClientRect();
        const box = tooltip.getBoundingClientRect();
        tooltip.style.left = `${Math.max(8, Math.min(local.x + 14, rect.width - box.width - 8))}px`;
        tooltip.style.top = `${Math.max(8, Math.min(local.y + 14, rect.height - box.height - 8))}px`;
    }

    function localPoint(event) {
        const rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function setHover(target) {
        const current = renderer.laneEditor.hover;
        canvas.classList.toggle('cursor-pointer', !!target);
        if (current?.approach === target?.approach && current?.lane === target?.lane) return;
        renderer.laneEditor.hover = target;
        renderer.draw();
    }

    function open() {
        isOpen = true;
        renderer.hoverNodeId = null;
        renderer.setLaneEditor(isDirty);
        render();
    }

    function close() {
        isOpen = false;
        renderer.setLaneEditor(null);
        canvas.classList.remove('cursor-pointer');
        tooltip.classList.add('hidden');
        render();
    }

    async function request(method, body = null) {
        const response = await fetch(laneUseUrl(), {
            method,
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content ?? '',
            },
            body: body ? JSON.stringify(body) : null,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
        return payload;
    }

    async function save() {
        const changed = dirtyApproaches();
        isBusy = true;
        render('Saving…');
        try {
            const payload = await request('PUT', {
                approaches: changed.map((approach) => {
                    const { lanes, turnLanes } = snapshotOf(approach);
                    return { nodeId: approach.nodeId, key: approach.laneUseKey, lanes, turnLanes: turnLanes ?? {} };
                }),
            });
            for (const approach of changed) saved.set(approach.id, snapshotOf(approach));
            if (corridorDescriptor()) corridorDescriptor().hasEdits = payload.hasEdits;
            isBusy = false;
            renderer.draw();
            render(`Saved ${changed.length} approach${changed.length === 1 ? '' : 'es'} to your layout`);
            logChange('lane-use', `saved ${changed.length} approaches`);
            await onSaved();
        } catch (error) {
            isBusy = false;
            render(`Save failed: ${error.message}`);
        }
    }

    function discard() {
        let isTurnLaneChanged = false;
        for (const approach of approaches()) {
            const snapshot = saved.get(approach.id);
            if (!snapshot) continue;
            snapshot.lanes.forEach((token, lane) => approach.laneUse[lane].splice(0, Infinity, ...movesFromToken(token)));
            for (const side of TURN_LANE_SIDES) {
                if (!isTurnLaneDirty(approach, side)) continue;
                const turnLane = snapshot.turnLanes?.[side];
                approach.turnLanes[side] = turnLane ? { lengthM: turnLane.lengthM, laneUse: movesFromToken(turnLane.laneUse) } : null;
                isTurnLaneChanged = true;
            }
        }
        // Turn lanes change the road itself, so the test layout is rebuilt around them.
        if (isTurnLaneChanged) rebuildLayout();
        else renderer.refreshLaneArrows();
        render('Unsaved changes discarded');
        logChange('lane-use', 'discarded unsaved changes');
    }

    async function revert() {
        // eslint-disable-next-line no-alert
        if (!window.confirm('Put this layout back as it was imported? Every saved lane arrow and turn lane edit on it is lost, and the simulation restarts.')) return;
        isBusy = true;
        render('Reverting…');
        try {
            const payload = await request('DELETE');
            if (corridorDescriptor()) corridorDescriptor().hasEdits = payload.hasEdits;
            isBusy = false;
            await reloadCorridor();
            logChange('lane-use', 'reverted to the original file');
        } catch (error) {
            isBusy = false;
            render(`Revert failed: ${error.message}`);
        }
    }

    el.save.addEventListener('click', save);
    el.discard.addEventListener('click', discard);
    el.revert.addEventListener('click', revert);

    canvas.addEventListener('contextmenu', (event) => {
        if (!isOpen) return;
        event.preventDefault();
        const target = renderer.hitTestLaneArrow(localPoint(event));
        if (target) cycle(target.approach, target.lane, -1);
    });

    return {
        get isOpen() {
            return isOpen;
        },

        /** Approaches with edits not saved yet. */
        get dirtyCount() {
            return dirtyApproaches().length;
        },

        isTurnLaneDirty,

        open() {
            if (!isOpen) open();
        },

        /** Call after every corridor (re)load: the loaded markings and turn lanes become the "saved" baseline. */
        corridorLoaded() {
            saved = new Map(approaches().map((approach) => [approach.id, snapshotOf(approach)]));
            if (isOpen) renderer.setLaneEditor(isDirty);
            render();
        },

        /** Call after the layout was rebuilt around unsaved turn-lane edits - the baseline stays, the overlay is redrawn. */
        layoutRebuilt() {
            if (isOpen) renderer.setLaneEditor(isDirty);
            render();
        },

        close() {
            if (isOpen) close();
        },

        pointerDown(event) {
            pointerDownAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
        },

        /** @returns true if the editor handled this as a click on an arrow. */
        pointerUp(event) {
            const start = pointerDownAt;
            pointerDownAt = null;
            if (!isOpen || !start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX) return false;
            const target = renderer.hitTestLaneArrow(localPoint(event));
            if (!target) return false;
            cycle(target.approach, target.lane, 1);
            showTip(target.approach, target.lane, localPoint(event));
            return true;
        },

        /** @returns true while the editor owns hover (the intersection tooltip stays out of the way). */
        hover(event) {
            if (!isOpen) return false;
            const local = localPoint(event);
            const target = renderer.hitTestLaneArrow(local);
            setHover(target);
            if (target) showTip(target.approach, target.lane, local);
            else tooltip.classList.add('hidden');
            return true;
        },
    };
}
