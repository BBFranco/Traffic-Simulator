/**
 * /road-editor page script. It opens on the whole corridor (running, nothing
 * editable); clicking an intersection there - or picking one from the list -
 * switches to that intersection alone, lifted out as its own little layout
 * (sim/intersectionLayout.js) with test traffic arriving on every approach,
 * and the lane-arrow editor (laneEditor.js) open on it. The Turn lanes panel adds or removes a short extra lane on
 * either side of any approach; that changes the road, so the test layout is
 * rebuilt around it (unsaved arrow edits carried over). Saving writes that
 * intersection's arrows and turn lanes back into the corridor file; nothing
 * about the test traffic itself is saved.
 *
 * The layouts are the user's own (Import adds one from a corridor JSON file,
 * checked with the same loader the simulator uses before it's uploaded).
 */
import { DEFAULT_TURN_LANE_LENGTH_M, TURN_LANE_SIDES, buildLayout, laneUseToken, turnLanesToConfig } from './sim/corridor.js';
import { LayoutRenderer } from './sim/renderer.js';
import { SimulationEngine } from './sim/engine.js';
import { buildIntersectionConfig } from './sim/intersectionLayout.js';
import { createLaneEditor } from './laneEditor.js';
import { onThemeChange } from './theme.js';

const FIXED_DT_S = 0.1;
/** Most ticks one animation frame may run, so a slow frame never snowballs into a freeze. */
const MAX_TICKS_PER_FRAME = 40;
/** How much road the Fit button frames around the junction (metres across the shorter canvas side). */
const FIT_SPAN_M = 110;
/** A pointer that moves further than this between down and up was a pan, not a click. */
const CLICK_SLOP_PX = 5;
const HINTS = {
    overview: 'Click an intersection to edit it · drag to pan · scroll to zoom',
    intersection: 'Click an arrow to change it · right-click steps back · drag to pan · scroll to zoom',
};
/** Turn lane length the editor allows - the test layout's shortest run-in is 150 m. */
const TURN_LANE_MIN_M = 5;
const TURN_LANE_MAX_M = 120;
/** Each side of an approach: the turn a lane there is for, and how the panel names it. */
const TURN_LANE_SIDE_INFO = {
    left: { movement: 'left', label: 'Left', hint: 'kerb side' },
    right: { movement: 'right', label: 'Right', hint: 'median side' },
};
const DIRECTION_LABELS = { northbound: 'Northbound', southbound: 'Southbound', eastbound: 'Eastbound', westbound: 'Westbound' };

const boot = JSON.parse(document.getElementById('road-editor-boot').textContent);

const el = {
    corridorSelect: document.getElementById('editor-corridor-select'),
    nodeList: document.getElementById('editor-node-list'),
    error: document.getElementById('editor-error'),
    canvas: document.getElementById('editor-canvas'),
    tooltip: document.getElementById('editor-tooltip'),
    runToggle: document.getElementById('editor-run-toggle'),
    reset: document.getElementById('editor-reset'),
    clock: document.getElementById('editor-clock'),
    nodeTitle: document.getElementById('editor-node-title'),
    arterialDemand: document.getElementById('editor-arterial-demand'),
    arterialDemandValue: document.getElementById('editor-arterial-demand-value'),
    crossDemand: document.getElementById('editor-cross-demand'),
    crossDemandValue: document.getElementById('editor-cross-demand-value'),
    turnShare: document.getElementById('editor-turn-share'),
    turnShareValue: document.getElementById('editor-turn-share-value'),
    turnLanes: document.getElementById('editor-turn-lanes'),
    overview: document.getElementById('editor-overview'),
    importButton: document.getElementById('editor-import'),
    importFile: document.getElementById('editor-import-file'),
    deleteLayout: document.getElementById('editor-delete-layout'),
    intersectionSection: document.getElementById('editor-intersection-section'),
    hint: document.getElementById('editor-hint'),
};

const state = {
    corridorId: boot.defaultCorridorId,
    /** The corridor file as last fetched - rebuilt from after every save so switching intersections shows saved arrows. */
    corridorConfig: null,
    corridorLayout: null,
    /** The intersection being edited - null while showing the whole corridor. */
    nodeId: null,
    running: false,
    speed: 1,
};

let layout = null;
let engine = null;
let accumulatorS = 0;
let lastFrameMs = null;

const renderer = new LayoutRenderer(el.canvas);

const laneEditor = createLaneEditor({
    canvas: el.canvas,
    tooltip: el.tooltip,
    renderer,
    boot,
    getLayout: () => layout,
    getEngine: () => engine,
    getCorridorId: () => state.corridorId,
    reloadCorridor: () => loadCorridor(state.corridorId, { keepNode: true }),
    rebuildLayout: () => rebuildLayout(),
    // The file changed - refresh the in-memory copy without touching the running test.
    onSaved: async () => {
        state.corridorConfig = await fetchCorridor(state.corridorId);
        state.corridorLayout = buildLayout(state.corridorConfig);
    },
    onChange: () => {
        renderNodeList();
        renderTurnLanePanel();
    },
});

/* ------------------------------------------------------------ loading */

async function fetchCorridor(id) {
    const response = await fetch(boot.corridorUrlTemplate.replace('__ID__', encodeURIComponent(id)), { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Failed to load corridor "${id}" (HTTP ${response.status}).`);
    return response.json();
}

async function loadCorridor(id, { keepNode = false } = {}) {
    const config = await fetchCorridor(id);
    state.corridorConfig = config;
    state.corridorLayout = buildLayout(config);
    state.corridorId = id;
    el.error.classList.add('hidden');

    if (keepNode && state.corridorLayout.nodesById.has(state.nodeId)) selectNode(state.nodeId, { force: true });
    else showOverview({ force: true });
}

const isOverview = () => state.nodeId === null;

/** The whole corridor as it is in the file, running with the test traffic settings - look only, pick an intersection to edit. */
function showOverview({ force = false } = {}) {
    if (!force && (isOverview() || !confirmDiscardUnsaved())) return;
    state.nodeId = null;

    // Its own copy - the engine and the "Cars turning" slider write into the layout they run on.
    layout = buildLayout(state.corridorConfig);
    applyTurnShare();
    engine = new SimulationEngine(layout);
    renderer.setLayout(layout);
    resetTraffic();

    laneEditor.corridorLoaded();
    laneEditor.close();
    el.nodeTitle.textContent = layout.name;
    renderMode();
}

/**
 * Folds the Intersection section (corridor + intersection picker) away, leaving
 * the header with the intersection's name - an intersection is being edited, so
 * the turn lanes and arrows come first. Its header opens it again.
 */
function setIntersectionSectionCollapsed(isCollapsed) {
    const section = el.intersectionSection;
    section.querySelector('[data-section-toggle]').setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    section.querySelector('[data-section-body]').classList.toggle('hidden', isCollapsed);
    const summary = section.querySelector('[data-section-summary]');
    summary.textContent = isCollapsed && !isOverview() ? `· ${layout.nodesById.get(state.nodeId).name}` : '';
    summary.classList.toggle('hidden', !summary.textContent);
}

/** Toolbar, hint and side panels for whichever view is showing. */
function renderMode() {
    setIntersectionSectionCollapsed(!isOverview());
    el.overview.classList.toggle('hidden', isOverview());
    el.hint.textContent = isOverview() ? HINTS.overview : HINTS.intersection;
    el.tooltip.classList.add('hidden');
    renderNodeList();
    renderTurnLanePanel();
}

function confirmDiscardUnsaved() {
    const count = laneEditor.dirtyCount;
    // eslint-disable-next-line no-alert
    return !count || window.confirm(`${count} approach${count === 1 ? ' has' : 'es have'} unsaved changes. Discard them?`);
}

/** The test layout (and a fresh engine on it) for the selected intersection, with `approachEdits` laid over the saved file. */
function buildTestLayout(approachEdits = []) {
    const config = buildIntersectionConfig(
        state.corridorConfig,
        state.corridorLayout,
        state.nodeId,
        { arterial: Number(el.arterialDemand.value), cross: Number(el.crossDemand.value) },
        approachEdits
    );
    const nextLayout = buildLayout(config);
    layout = nextLayout;
    applyTurnShare();
    engine = new SimulationEngine(layout);
}

function selectNode(nodeId, { force = false } = {}) {
    if (!force && (nodeId === state.nodeId || !confirmDiscardUnsaved())) return;
    state.nodeId = nodeId;

    buildTestLayout();
    renderer.setLayout(layout);
    fitJunction();
    resetTraffic();

    laneEditor.corridorLoaded();
    laneEditor.open();
    el.nodeTitle.textContent = layout.nodesById.get(nodeId).name;
    renderMode();
}

/** The selected intersection's approaches that carry traffic - the ones with lanes to mark. */
function editableApproaches() {
    return layout?.nodesById.get(state.nodeId)?.approaches.filter((approach) => approach.laneUse) ?? [];
}

/** Every approach's current (possibly unsaved) arrows and turn lanes, in corridor JSON form. */
function currentApproachEdits() {
    return editableApproaches().map((approach) => ({
        laneUseKey: approach.laneUseKey,
        laneUse: approach.laneUse.map(laneUseToken),
        turnLanes: turnLanesToConfig(approach.turnLanes),
    }));
}

/** After a turn lane was added, removed or resized: same intersection, same camera, unsaved edits kept, test traffic restarted. False if the edit doesn't build. */
function rebuildLayout() {
    try {
        buildTestLayout(currentApproachEdits());
        el.error.classList.add('hidden');
    } catch (error) {
        el.error.textContent = error.message;
        el.error.classList.remove('hidden');
        return false;
    }
    renderer.setLayout(layout, { refit: false });
    resetTraffic();
    laneEditor.layoutRebuilt();
    renderTurnLanePanel();
    return true;
}

/* --------------------------------------------------------- turn lanes */

/** Why `side` can't have a turn lane on `approach`, or null if it can. */
function turnLaneUnavailableReason(approach, side) {
    const { movement } = TURN_LANE_SIDE_INFO[side];
    if (!engine.movementsAt(approach).includes(movement)) return `No ${movement} turn here`;
    if (side !== 'right' || approach.kind === 'arterial') return null;
    const connector = layout.connectors.find((c) => c.id === approach.connectorId);
    if (connector.twoWay && connector.medianWidthM < connector.laneWidthM) return 'Needs a median a lane wide';
    return null;
}

function setTurnLane(approach, side, lengthM) {
    const current = approach.turnLanes[side];
    approach.turnLanes[side] = lengthM === null ? null : { lengthM, laneUse: current?.laneUse ?? [TURN_LANE_SIDE_INFO[side].movement] };
    if (rebuildLayout()) return;
    approach.turnLanes[side] = current;
    renderTurnLanePanel();
}

function turnLaneRow(approach, side) {
    const info = TURN_LANE_SIDE_INFO[side];
    const turnLane = approach.turnLanes[side];
    const reason = turnLaneUnavailableReason(approach, side);

    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 text-xs';

    const label = document.createElement('label');
    label.className = 'flex min-w-0 flex-1 items-center gap-1.5 text-slate-700 dark:text-slate-300';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'rounded border-slate-300 text-sky-600 focus:ring-sky-500 disabled:opacity-40 dark:border-slate-600 dark:bg-slate-800';
    toggle.checked = !!turnLane;
    toggle.disabled = !!reason && !turnLane;
    const text = document.createElement('span');
    text.className = 'truncate';
    text.textContent = info.label;
    const hint = document.createElement('span');
    hint.className = 'shrink-0 text-[10px] text-slate-400';
    hint.textContent = reason && !turnLane ? reason : info.hint;
    label.append(toggle, text, hint);

    const length = document.createElement('input');
    length.type = 'number';
    length.min = String(TURN_LANE_MIN_M);
    length.max = String(TURN_LANE_MAX_M);
    length.step = '1';
    length.value = String(turnLane?.lengthM ?? DEFAULT_TURN_LANE_LENGTH_M);
    length.disabled = !turnLane;
    length.title = 'Length in metres, up to the stop line';
    length.className =
        'w-16 rounded-md border-slate-300 bg-white py-1 text-right font-mono text-[11px] text-slate-900 focus:border-sky-500 focus:ring-sky-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';
    const unit = document.createElement('span');
    unit.className = 'text-[11px] text-slate-500';
    unit.textContent = 'm';

    const readLength = () => Math.min(TURN_LANE_MAX_M, Math.max(TURN_LANE_MIN_M, Math.round(Number(length.value) || DEFAULT_TURN_LANE_LENGTH_M)));
    toggle.addEventListener('change', () => setTurnLane(approach, side, toggle.checked ? readLength() : null));
    length.addEventListener('change', () => {
        if (approach.turnLanes[side]) setTurnLane(approach, side, readLength());
    });

    row.append(label, length, unit);
    if (laneEditor.isTurnLaneDirty(approach, side)) {
        const badge = document.createElement('span');
        badge.className = 'shrink-0 rounded bg-amber-100 px-1 text-[9px] text-amber-700 dark:bg-amber-500/15 dark:text-amber-300';
        badge.textContent = 'unsaved';
        row.append(badge);
    }
    return row;
}

function renderTurnLanePanel() {
    if (!layout || !engine) return;
    if (isOverview()) {
        const note = document.createElement('p');
        note.className = 'text-[11px] text-slate-500';
        note.textContent = 'Pick an intersection on the map or in the list to add turn lanes to it.';
        el.turnLanes.replaceChildren(note);
        return;
    }
    el.turnLanes.replaceChildren(
        ...editableApproaches().map((approach) => {
            const group = document.createElement('div');
            group.className = 'space-y-1.5 rounded-md border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-800/60';
            const heading = document.createElement('div');
            heading.className = 'text-[10px] font-semibold uppercase tracking-wider text-slate-500';
            heading.textContent = approach.kind === 'arterial' ? approach.label : `${approach.label} · ${DIRECTION_LABELS[approach.laneUseKey] ?? approach.laneUseKey}`;
            group.append(heading, ...TURN_LANE_SIDES.map((side) => turnLaneRow(approach, side)));
            return group;
        })
    );
}

function resetTraffic() {
    const demand = {};
    for (const arterial of layout.arterials) demand[arterial.id] = Number(el.arterialDemand.value);
    for (const connector of layout.connectors) demand[connector.id] = Number(el.crossDemand.value);
    engine.reset({
        seed: 1,
        arterialModes: {},
        demand,
        sensorMode: 'inductive_loop',
        batteryBackedSensors: true,
        power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 },
    });
    accumulatorS = 0;
    renderFrame();
}

/** The "Cars turning" slider sets both ways round: main road onto the cross street, and cross street onto the main road. */
function applyTurnShare() {
    const share = Number(el.turnShare.value) / 100;
    for (const connector of layout?.connectors ?? []) {
        connector.crossChance = share;
        connector.turnChance = share;
    }
}

function fitJunction() {
    const node = layout.nodesById.get(state.nodeId);
    const { width, height } = renderer.camera.viewport;
    renderer.camera.centreOn(node.point, Math.min(width, height) / FIT_SPAN_M);
    renderer.draw();
}

/* --------------------------------------------------------- node picker */

function pickerButton(label, isActive, onClick, badgeText = null) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.active = isActive ? 'true' : 'false';
    button.className =
        'flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition ' +
        'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-100 ' +
        'data-[active=true]:border-sky-500 data-[active=true]:bg-sky-50 data-[active=true]:text-sky-800 ' +
        'dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 ' +
        'dark:data-[active=true]:border-sky-400 dark:data-[active=true]:bg-sky-500/10 dark:data-[active=true]:text-sky-200';
    const name = document.createElement('span');
    name.className = 'truncate';
    name.textContent = label;
    button.append(name);
    if (badgeText) {
        const badge = document.createElement('span');
        badge.className = 'shrink-0 rounded bg-amber-100 px-1 text-[9px] text-amber-700 dark:bg-amber-500/15 dark:text-amber-300';
        badge.textContent = badgeText;
        button.append(badge);
    }
    button.addEventListener('click', onClick);
    return button;
}

function renderNodeList() {
    const corridor = state.corridorLayout;
    if (!corridor) return;
    const dirtyCount = laneEditor.dirtyCount;

    el.nodeList.replaceChildren(
        pickerButton('Whole corridor', isOverview(), () => showOverview()),
        ...corridor.arterials.map((arterial) => {
            const group = document.createElement('div');
            const heading = document.createElement('div');
            heading.className = 'mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500';
            heading.textContent = arterial.shortName;
            const list = document.createElement('div');
            list.className = 'grid grid-cols-1 gap-1';

            for (const node of arterial.intersections) {
                const isActive = node.id === state.nodeId;
                list.append(pickerButton(node.name, isActive, () => selectNode(node.id), isActive && dirtyCount ? `${dirtyCount} unsaved` : null));
            }

            group.append(heading, list);
            return group;
        })
    );
}

/** Whole-corridor view: ring the intersection under the pointer and say it can be clicked. */
function hoverOverview(event) {
    const local = localPoint(event);
    const node = renderer.hitTestIntersection(local);
    el.canvas.classList.toggle('cursor-pointer', !!node);
    if (renderer.hoverNodeId !== (node?.id ?? null)) {
        renderer.hoverNodeId = node?.id ?? null;
        renderer.draw();
    }
    if (!node) {
        el.tooltip.classList.add('hidden');
        return;
    }
    const title = document.createElement('div');
    title.className = 'font-semibold text-slate-900 dark:text-slate-100';
    title.textContent = node.name;
    const action = document.createElement('div');
    action.className = 'mt-0.5 text-sky-700 dark:text-sky-300';
    action.textContent = 'Click to edit this intersection';
    el.tooltip.replaceChildren(title, action);
    el.tooltip.classList.remove('hidden');
    const rect = el.canvas.getBoundingClientRect();
    const box = el.tooltip.getBoundingClientRect();
    el.tooltip.style.left = `${Math.max(8, Math.min(local.x + 14, rect.width - box.width - 8))}px`;
    el.tooltip.style.top = `${Math.max(8, Math.min(local.y + 14, rect.height - box.height - 8))}px`;
}

function localPoint(event) {
    const rect = el.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/* --------------------------------------------------------- run loop */

function renderRunToggle() {
    el.runToggle.dataset.active = state.running ? 'true' : 'false';
    el.runToggle.querySelector('[data-when-inactive]').classList.toggle('hidden', state.running);
    el.runToggle.querySelector('[data-when-active]').classList.toggle('hidden', !state.running);
}

function renderFrame() {
    const snapshot = engine.snapshot();
    renderer.setDynamicState({ cars: snapshot.cars, signals: snapshot.signals });
    renderer.draw();
    const t = engine.simTimeS;
    el.clock.textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
}

function animate(nowMs) {
    const elapsedS = lastFrameMs === null ? 0 : Math.min(0.25, (nowMs - lastFrameMs) / 1000);
    lastFrameMs = nowMs;

    if (state.running && engine) {
        accumulatorS += elapsedS * state.speed;
        let ticks = 0;
        while (accumulatorS >= FIXED_DT_S && ticks < MAX_TICKS_PER_FRAME) {
            engine.tick(FIXED_DT_S);
            accumulatorS -= FIXED_DT_S;
            ticks += 1;
        }
        if (ticks === MAX_TICKS_PER_FRAME) accumulatorS = 0;
        renderFrame();
    }

    requestAnimationFrame(animate);
}

/* --------------------------------------------------------- controls */

el.runToggle.addEventListener('click', () => {
    state.running = !state.running;
    renderRunToggle();
});

el.reset.addEventListener('click', () => {
    if (engine) resetTraffic();
});

document.querySelectorAll('button[data-control="editor-speed"]').forEach((button) => {
    button.addEventListener('click', () => {
        document.querySelectorAll('button[data-control="editor-speed"]').forEach((option) => {
            const isActive = option === button;
            option.dataset.active = isActive ? 'true' : 'false';
            option.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
        state.speed = Number(button.dataset.value);
    });
});

function syncSliderReadouts() {
    el.arterialDemandValue.textContent = `${el.arterialDemand.value} veh/lane/min`;
    el.crossDemandValue.textContent = `${el.crossDemand.value} veh/lane/min`;
    el.turnShareValue.textContent = `${el.turnShare.value}%`;
}

el.arterialDemand.addEventListener('input', () => {
    syncSliderReadouts();
    for (const arterial of layout?.arterials ?? []) engine?.setDemand(arterial.id, Number(el.arterialDemand.value));
});
el.crossDemand.addEventListener('input', () => {
    syncSliderReadouts();
    for (const connector of layout?.connectors ?? []) engine?.setDemand(connector.id, Number(el.crossDemand.value));
});
el.turnShare.addEventListener('input', () => {
    syncSliderReadouts();
    applyTurnShare();
});

el.corridorSelect.addEventListener('change', async () => {
    const requested = el.corridorSelect.value;
    if (!confirmDiscardUnsaved()) {
        el.corridorSelect.value = state.corridorId;
        return;
    }
    try {
        await loadCorridor(requested);
    } catch (error) {
        el.corridorSelect.value = state.corridorId;
        el.error.textContent = error.message;
        el.error.classList.remove('hidden');
    }
});

window.addEventListener('beforeunload', (event) => {
    if (laneEditor.dirtyCount) event.preventDefault();
});

/* --------------------------------------------------------- camera + clicks */

let dragging = null;
let pointerDownAt = null;

el.canvas.addEventListener('pointerdown', (event) => {
    el.canvas.setPointerCapture(event.pointerId);
    dragging = { x: event.clientX, y: event.clientY };
    pointerDownAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    laneEditor.pointerDown(event);
});

el.canvas.addEventListener('pointermove', (event) => {
    if (dragging) {
        renderer.camera.panByPixels(event.clientX - dragging.x, event.clientY - dragging.y);
        dragging = { x: event.clientX, y: event.clientY };
        renderer.draw();
        return;
    }
    if (isOverview()) hoverOverview(event);
    else laneEditor.hover(event);
});

el.canvas.addEventListener('pointerup', (event) => {
    const isClick = pointerDownAt && Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y) <= CLICK_SLOP_PX;
    pointerDownAt = null;
    if (isOverview()) {
        const node = isClick ? renderer.hitTestIntersection(localPoint(event)) : null;
        if (node) selectNode(node.id);
    } else {
        laneEditor.pointerUp(event);
    }
    dragging = null;
    if (el.canvas.hasPointerCapture(event.pointerId)) el.canvas.releasePointerCapture(event.pointerId);
});

el.canvas.addEventListener('pointercancel', () => {
    dragging = null;
});

el.canvas.addEventListener('pointerleave', () => {
    el.tooltip.classList.add('hidden');
    if (!isOverview() || renderer.hoverNodeId === null) return;
    renderer.hoverNodeId = null;
    renderer.draw();
});

el.canvas.addEventListener(
    'wheel',
    (event) => {
        event.preventDefault();
        const rect = el.canvas.getBoundingClientRect();
        renderer.camera.zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-event.deltaY * 0.0015));
        renderer.draw();
    },
    { passive: false }
);

function zoomButton(factor) {
    const { width, height } = renderer.camera.viewport;
    renderer.camera.zoomAt({ x: width / 2, y: height / 2 }, factor);
    renderer.draw();
}

document.getElementById('editor-zoom-in').addEventListener('click', () => zoomButton(1.35));
document.getElementById('editor-zoom-out').addEventListener('click', () => zoomButton(1 / 1.35));
document.getElementById('editor-zoom-fit').addEventListener('click', () => {
    if (!layout) return;
    if (isOverview()) renderer.fit();
    else fitJunction();
});
el.overview.addEventListener('click', () => showOverview());
el.intersectionSection.querySelector('[data-section-toggle]').addEventListener('click', (event) => {
    setIntersectionSectionCollapsed(event.currentTarget.getAttribute('aria-expanded') === 'true');
});

new ResizeObserver(() => {
    renderer.resize();
    renderer.draw();
}).observe(document.getElementById('editor-canvas-wrap'));

/* --------------------------------------------------------- import / delete */

function showError(message) {
    el.error.textContent = message;
    el.error.classList.remove('hidden');
}

async function sendLayoutRequest(url, method, body = null) {
    const response = await fetch(url, {
        method,
        headers: { Accept: 'application/json', 'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content ?? '' },
        body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.errors?.layout?.[0] ?? payload.message ?? `HTTP ${response.status}`);
    return payload;
}

/** The layout picker, rebuilt from `boot.corridors` after an import or delete. */
function renderLayoutOptions() {
    el.corridorSelect.replaceChildren(
        ...boot.corridors.map((corridor) => {
            const option = document.createElement('option');
            option.value = corridor.id;
            option.textContent = corridor.name;
            option.selected = corridor.id === state.corridorId;
            return option;
        })
    );
    el.deleteLayout.disabled = boot.corridors.length < 2;
}

/** Checks the file with the simulator's own loader first, so a broken layout is explained here rather than failing on the Simulator page later. */
async function importLayout(file) {
    let config;
    try {
        config = JSON.parse(await file.text());
        buildLayout(config);
    } catch (error) {
        showError(`Couldn't import ${file.name}: ${error.message}`);
        return;
    }
    if (!confirmDiscardUnsaved()) return;

    const form = new FormData();
    form.append('layout', file);
    try {
        const { layout: descriptor } = await sendLayoutRequest(boot.importUrl, 'POST', form);
        boot.corridors.push(descriptor);
        state.corridorId = descriptor.id;
        renderLayoutOptions();
        await loadCorridor(descriptor.id);
    } catch (error) {
        showError(`Couldn't import ${file.name}: ${error.message}`);
    }
}

async function deleteLayout() {
    const descriptor = boot.corridors.find((c) => c.id === state.corridorId);
    // eslint-disable-next-line no-alert
    if (!descriptor || !window.confirm(`Delete "${descriptor.name}" from your layouts? This can't be undone.`)) return;
    try {
        const { defaultCorridorId } = await sendLayoutRequest(boot.deleteUrlTemplate.replace('__ID__', encodeURIComponent(descriptor.id)), 'DELETE');
        boot.corridors = boot.corridors.filter((c) => c.id !== descriptor.id);
        state.corridorId = defaultCorridorId;
        renderLayoutOptions();
        await loadCorridor(defaultCorridorId);
    } catch (error) {
        showError(error.message);
    }
}

el.importButton.addEventListener('click', () => el.importFile.click());
el.importFile.addEventListener('change', () => {
    const [file] = el.importFile.files;
    el.importFile.value = '';
    if (file) importLayout(file);
});
el.deleteLayout.addEventListener('click', deleteLayout);

/* --------------------------------------------------------------------- boot */

(async function start() {
    onThemeChange((theme) => renderer.setTheme(theme));
    renderLayoutOptions();
    syncSliderReadouts();
    renderRunToggle();
    try {
        await loadCorridor(state.corridorId);
    } catch (error) {
        el.error.textContent = error.message;
        el.error.classList.remove('hidden');
    }
    requestAnimationFrame(animate);
})();
