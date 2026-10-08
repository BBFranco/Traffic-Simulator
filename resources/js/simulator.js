/**
 * /simulator page script - PHASE 2 (build steps 2-6: single-intersection engine).
 *
 * What this file does:
 *   - loads a corridor layout config and draws it (corridor.js -> renderer.js)
 *   - runs the camera: drag to pan, wheel to zoom, double-click to centre
 *   - builds the controls that depend on the loaded corridor (per-arterial mode
 *     selectors, demand sliders, stats-footer columns)
 *   - holds the control state, reflects it in the UI, and logs every change
 *   - owns the fixed-timestep animation loop and drives `engine.js` from it:
 *     `Run`/`Pause` gate whether ticks advance, `Step` advances exactly one
 *     tick, `Reset` restarts the engine at t=0 with the current seed/config.
 *
 * Corridor-wide coordination (connectors carrying traffic, cross-routing,
 * green wave) is not here yet - that is build steps 7-14. This file already
 * drives the engine generically per-arterial/per-node so those steps extend
 * it rather than rewrite it.
 */

import { buildLayout, corridorCounts } from './sim/corridor.js';
import { ARTERIAL_ACCENTS } from './sim/renderer.js';
import { Renderer2D } from './renderers/Renderer2D.js';
import { VIEW_2D, VIEW_3D } from './renderers/RendererInterface.js';
import { SimulationEngine, CHART_SAMPLE_INTERVAL_S } from './sim/engine.js';
import { Chart, INK, applyChartTheme, baseOptions, lineDataset } from './charts/theme.js';
import { onThemeChange } from './theme.js';
import { initTooltips } from './tooltips.js';

/** Physics timestep - decoupled from render framerate so batch mode (build step 13) reuses the same engine unmodified. */
const FIXED_DT_S = 0.1;

/** Sentinel node id for the arterial-wide "Total" chip appended to the per-intersection cleared-by-road-section chips. */
const ARTERIAL_TOTAL_CHIP_ID = 'arterial-total';

const boot = JSON.parse(document.getElementById('sim-boot').textContent);

const MODE_LABELS = {
    fixed: 'Fixed-time',
    adaptive: 'Adaptive',
    green_wave: 'Green wave',
    /** Not a mode a user picks - set by a corridor config for a highway backbone (mode:"none" in corridor.js). */
    none: 'Free flow',
};

const SENSOR_LABELS = {
    none: 'None (timer)',
    inductive_loop: 'Inductive loop',
    radar: 'Radar',
    camera: 'Camera',
    magnetometer: 'Magnetometer',
};

/**
 * Status-pill classes, kept in step with the `$pillBase` fragment in
 * simulator.blade.php. Light is the base, `dark:` is night mode.
 */
const PILL_BASE = 'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium';

const PILL_TONES = {
    neutral: `${PILL_BASE} border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-400`,
    emerald: `${PILL_BASE} border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300`,
    rose: `${PILL_BASE} border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-500/50 dark:bg-rose-500/15 dark:text-rose-300`,
};

const DOT_TONES = {
    neutral: 'h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500',
    emerald: 'h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400',
    rose: 'h-1.5 w-1.5 rounded-full bg-rose-500 dark:bg-rose-400',
};

/* --------------------------------------------------------------------- state */

const state = {
    corridorId: boot.defaultCorridorId,
    seed: Number(document.getElementById('seed-input').value),
    running: false,
    speed: 1,
    /** Per arterial id -> 'fixed' | 'adaptive' | 'green_wave'. */
    arterialModes: {},
    sensorMode: 'inductive_loop',
    batteryBackedSensors: true,
    power: {
        loadShedding: false,
        scheduledOutages: false,
        offMinutes: 2,
        periodMinutes: 8,
    },
    /** Per arterial/connector id -> vehicles per lane per minute. */
    demand: {},
    /** Fraction (0-1) of newly-spawned vehicles that are trucks - see engine.js's setTruckRatio(). */
    truckRatio: 0,
    /** Fraction (0-1) of newly-spawned vehicles that are buses - see engine.js's setBusRatio(). */
    busRatio: 0,
    /** Just-for-fun traffic characters - see engine.js's setRandomEvents(). Always off in replays and batch runs. */
    randomEvents: false,
    /** 'random' (turn dice) or 'destination' (routed trips into driveways) - only offered when the corridor has a `routing` section. */
    routingMode: 'random',
};

let layout = null;
let engine = null;
let footerChart = null;
let lastChartSampleCount = 0;
let accumulatorS = 0;
let lastFrameMs = null;
let rafId = null;
/** Sim-clock target (seconds) for the "Run to t=1000s" button - set while catching up, null under normal Run/Pause control. */
let runUntilS = null;
/** Wall-clock budget per animation frame while catching up, so a long run-to-time still leaves the tab responsive instead of freezing it. */
const RUN_TO_TIME_FRAME_BUDGET_MS = 40;
/**
 * Whether reaching `runUntilS` should stop the run (the "Run to t=1000s" button's behaviour)
 * or hand off to normal speed-based playback (a replay's silent warm-up fast-forward). Reset
 * to `true` right after each catch-up consumes it, so it always defaults back for next time.
 */
let pauseAfterCatchUp = true;

/**
 * Batch-dataset runs available to replay, one representative per (controller_mode,
 * power_state, sensor_mode) condition - fetched from GET /simulator/sample-runs. See
 * fetchSampleRuns().
 */
let sampleRuns = [];
/** The "Power" side of the replay picker - 'normal' | 'load_shedding'. */
let replaySelectedPowerState = 'normal';
/**
 * Non-null while a replay is driving the engine automatically - tracks its own tick count
 * (independent of `engine.simTimeS`, since a replay always starts a fresh engine.reset() at
 * t=0) against the recorded run's warm-up/outage/duration schedule. Mirrors runHeadless.js's
 * own measuredTick bookkeeping exactly, so a replayed run reaches the same stats-reset and
 * outage timing the batch data itself was measured against.
 */
let replay = null;

const el = {
    canvasWrap: document.getElementById('canvas-wrap'),
    simClock: document.getElementById('sim-clock'),
    statsChartEmpty: document.getElementById('stats-chart-empty'),
    canvas: document.getElementById('sim-canvas'),
    tooltip: document.getElementById('node-tooltip'),
    outageOverlay: document.getElementById('outage-overlay'),
    carCard: document.getElementById('car-card'),
    corridorSelect: document.getElementById('corridor-select'),
    corridorDescription: document.getElementById('corridor-description'),
    corridorFacts: document.getElementById('corridor-facts'),
    corridorError: document.getElementById('corridor-error'),
    corridorErrorMessage: document.getElementById('corridor-error-message'),
    seedInput: document.getElementById('seed-input'),
    seedRandomise: document.getElementById('seed-randomise'),
    arterialModeControls: document.getElementById('arterial-mode-controls'),
    demandControls: document.getElementById('demand-controls'),
    truckRatioInput: document.getElementById('truck-ratio-input'),
    truckRatioValue: document.getElementById('truck-ratio-value'),
    busRatioInput: document.getElementById('bus-ratio-input'),
    busRatioValue: document.getElementById('bus-ratio-value'),
    randomEventsInput: document.getElementById('random-events'),
    destinationRoutingInput: document.getElementById('destination-routing'),
    statsColumns: document.getElementById('stats-columns'),
    runToggle: document.getElementById('run-toggle'),
    stepButton: document.getElementById('step-button'),
    runToTimeButton: document.getElementById('run-to-time-button'),
    resetButton: document.getElementById('reset-button'),
    loadSheddingToggle: document.getElementById('load-shedding-toggle'),
    replayEmptyState: document.getElementById('replay-empty-state'),
    replayPicker: document.getElementById('replay-picker'),
    replayFamilySelect: document.getElementById('replay-family-select'),
    replayLoadButton: document.getElementById('replay-load-button'),
    replayStatus: document.getElementById('replay-status'),
    runStatePill: document.getElementById('run-state-pill'),
    runStateLabel: document.getElementById('run-state-label'),
    powerPill: document.getElementById('power-pill'),
    powerLabel: document.getElementById('power-label'),
    sensorPillLabel: document.getElementById('sensor-pill-label'),
    controlLog: document.getElementById('control-log'),
};

initTooltips();

const renderer2d = new Renderer2D(el.canvas);
/** The 2D map's LayoutRenderer - the pan/zoom/hover/layer handlers below drive its camera directly, exactly as before. */
const renderer = renderer2d.inner;

/**
 * View switching. Renderers only ever READ engine.snapshot() - switching never
 * touches state.running, the engine, the seed or the accumulator, so the run
 * carries on tick-for-tick. three.js is loaded on first use so the default 2D
 * page ships no WebGL code.
 */
let activeView = VIEW_2D;
let renderer3d = null;
let currentTheme = 'light';
/** Bumped on every switch so a slow dynamic import can't attach a 3D view the user already left. */
let viewSwitchToken = 0;

function activeRenderer() {
    return activeView === VIEW_3D && renderer3d ? renderer3d : renderer2d;
}

async function setView(view) {
    const token = ++viewSwitchToken;

    if (view === VIEW_3D) {
        const { Renderer3D } = await import('./renderers/Renderer3D.js');
        if (token !== viewSwitchToken || renderer3d) return;
        renderer3d = new Renderer3D(el.canvasWrap, el.outageOverlay, FIXED_DT_S);
        renderer3d.setTheme(currentTheme);
        if (layout) renderer3d.init(layout);
        syncDriveways();
        renderer3d.setFollowCar(followSelected ? selectedCarId : null);
        watch3dClicks(renderer3d.canvas);
        el.canvas.classList.add('hidden');
        el.tooltip.classList.add('hidden');
        renderer.hoverNodeId = null;
    } else {
        renderer3d?.dispose();
        renderer3d = null;
        el.canvas.classList.remove('hidden');
        renderer2d.resize();
    }

    activeView = view;
    document.querySelectorAll('[data-view-only]').forEach((node) => {
        node.classList.toggle('hidden', node.dataset.viewOnly !== view);
    });
}

/* ----------------------------------------------------------------- log panel */

function logChange(control, value) {
    const detail = typeof value === 'object' ? JSON.stringify(value) : String(value);
    // eslint-disable-next-line no-console
    console.info(`[simulator:phase-1] ${control} = ${detail}  (UI state only - no engine attached)`);

    if (!el.controlLog) return;
    const li = document.createElement('li');
    li.className = 'flex gap-2';
    const key = document.createElement('span');
    key.className = 'shrink-0 text-slate-500';
    key.textContent = control;
    const val = document.createElement('span');
    val.className = 'min-w-0 flex-1 truncate text-sky-700 dark:text-sky-300';
    val.textContent = detail;
    li.append(key, val);
    el.controlLog.prepend(li);
    while (el.controlLog.children.length > 40) el.controlLog.lastElementChild.remove();
}

/* -------------------------------------------------------- generic segmented */

/**
 * Segmented controls are declared in Blade and identified by `data-control`.
 * A handler registry keeps the wiring in one place, including for the segmented
 * controls that are cloned per arterial at runtime.
 */
const segmentedHandlers = new Map();

document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-control][data-value]');
    if (!button) return;

    const control = button.dataset.control;
    const handler = segmentedHandlers.get(control);
    if (!handler) return;

    const group = button.closest('[data-segmented]');
    group.querySelectorAll('button[data-value]').forEach((option) => {
        const active = option === button;
        option.dataset.active = active ? 'true' : 'false';
        option.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    handler(button.dataset.value);
});

segmentedHandlers.set('speed', (value) => {
    state.speed = Number(value);
    logChange('speed', `${state.speed}x`);
});

segmentedHandlers.set('view', (value) => {
    setView(value === VIEW_3D ? VIEW_3D : VIEW_2D);
    logChange('view', value);
});

segmentedHandlers.set('replay-power-state', (value) => {
    replaySelectedPowerState = value;
});

/* -------------------------------------------------------- corridor loading */

async function loadCorridor(id, { config = null } = {}) {
    const resolved = config ?? (await fetchCorridor(id));

    layout = buildLayout(resolved);
    state.corridorId = id;

    // Reset the per-arterial state to whatever the config declares, then rebuild
    // every control that depends on the corridor's shape.
    state.arterialModes = {};
    state.demand = {};
    for (const arterial of layout.arterials) {
        state.arterialModes[arterial.id] = arterial.mode;
        state.demand[arterial.id] = arterial.demand.spawnRatePerLanePerMin;
    }
    for (const connector of layout.connectors) {
        state.demand[connector.id] = connector.demand.spawnRatePerLanePerMin;
    }

    clearCorridorError();
    renderer2d.init(layout);
    renderer3d?.init(layout);
    syncRoutingControl();
    renderCorridorSummary();
    buildArterialModeControls();
    buildDemandControls();
    buildStatsColumns();
    buildFooterChart();

    // A different corridor means different nodes/arterials, so the engine
    // (which precomputes stop-line distances per node at construction time)
    // has to be rebuilt from scratch, not just reset.
    engine = new SimulationEngine(layout);
    engine.setNodeStatsTracking(true); // the hover tooltip's per-junction wait and throughput
    engine.reset(engineResetOptions());
    syncDriveways();
    accumulatorS = 0;

    resetRunState();
    await fetchSampleRuns(id);

    logChange('corridor', `${id} (${layout.arterials.length} arterials, ${layout.connectors.length} connectors)`);
}

/** Current control-panel state, in the shape `SimulationEngine.reset()` expects. */
function engineResetOptions() {
    return {
        seed: state.seed,
        arterialModes: { ...state.arterialModes },
        demand: { ...state.demand },
        sensorMode: state.sensorMode,
        batteryBackedSensors: state.batteryBackedSensors,
        power: { ...state.power },
        truckRatio: state.truckRatio,
        busRatio: state.busRatio,
        randomEvents: state.randomEvents,
        routingMode: state.routingMode,
    };
}

/** Destination routing is only offered on a corridor that has a `routing` section - anywhere else it falls back to random turning. */
function syncRoutingControl() {
    const available = Boolean(layout.routing);
    if (!available) state.routingMode = 'random';
    el.destinationRoutingInput.disabled = !available;
    el.destinationRoutingInput.checked = state.routingMode === 'destination';
}

/** The driveways cars pull into, drawn only while destination routing is running. */
function syncDriveways() {
    const driveways = engine?.routingActive ? engine.routingModel.driveways : null;
    renderer2d.setDriveways(driveways);
    renderer3d?.setDriveways(driveways);
}

async function fetchCorridor(id) {
    const url = boot.corridorUrlTemplate.replace('__ID__', encodeURIComponent(id));
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
        throw new Error(`Failed to load corridor "${id}" (HTTP ${response.status}).`);
    }
    return response.json();
}

/**
 * Loads the "replay a batch run" picker's options for the given corridor - one representative
 * run per (controller_mode, power_state, sensor_mode) condition, from that corridor's latest batch
 * in the current routing mode. Called every time a corridor finishes loading (see loadCorridor())
 * or Destination routing is toggled, so the picker never offers a run for a corridor or routing
 * mode that isn't the one on screen.
 */
async function fetchSampleRuns(corridorId) {
    if (!el.replayPicker) return; // picker markup not present (should always exist, defensive only)

    try {
        const url = `/simulator/sample-runs?corridor=${encodeURIComponent(corridorId)}&routing=${state.routingMode}`;
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        sampleRuns = body.runs ?? [];
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to load sample runs for replay picker', error);
        sampleRuns = [];
    }

    populateReplayFamilySelect();
}

/** A stable key identifying a run's "family" - everything except power state (its own picker control). */
function replayFamilyKey(run) {
    return `${run.controller_mode}|${run.sensor_mode ?? ''}`;
}

/** Human label for a run's family, e.g. "Adaptive - Radar", "Fixed-time". */
function replayFamilyLabel(run) {
    const modeLabel = MODE_LABELS[run.controller_mode] ?? run.controller_mode;
    if (run.controller_mode !== 'adaptive' || !run.sensor_mode) return modeLabel;
    return `${modeLabel} - ${SENSOR_LABELS[run.sensor_mode] ?? run.sensor_mode}`;
}

function populateReplayFamilySelect() {
    const hasRuns = sampleRuns.length > 0;
    el.replayEmptyState?.classList.toggle('hidden', hasRuns);
    el.replayPicker?.classList.toggle('hidden', !hasRuns);
    if (!hasRuns) return;

    const previousValue = el.replayFamilySelect.value;
    const families = new Map(); // key -> label, first-seen order
    for (const run of sampleRuns) {
        const key = replayFamilyKey(run);
        if (!families.has(key)) families.set(key, replayFamilyLabel(run));
    }

    el.replayFamilySelect.replaceChildren(
        ...[...families].map(([key, label]) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = label;
            return option;
        })
    );
    if ([...families.keys()].includes(previousValue)) el.replayFamilySelect.value = previousValue;
}

function renderCorridorSummary() {
    el.corridorDescription.dataset.tip = layout.description || '';
    el.corridorDescription.setAttribute('aria-label', layout.description || '');
    el.corridorDescription.classList.toggle('hidden', !layout.description);

    // Real roads and junctions by kind (shared with the Results PDF cover) - not the config's road pieces.
    const counts = corridorCounts(layout);
    const facts = [
        ['Arterials', counts.arterialRoads],
        ['Side streets', counts.sideRoads],
        ['Signals', counts.signals],
        ['Roundabouts', counts.roundabouts],
        ['All-way stops', counts.allWayStops],
        ['Stop streets', counts.stopStreets],
    ];

    el.corridorFacts.replaceChildren(
        ...facts.flatMap(([term, value]) => {
            const wrap = document.createElement('div');
            wrap.className =
                'rounded border border-slate-200 bg-white px-1 py-1.5 dark:border-slate-800 dark:bg-slate-950/40';
            const dt = document.createElement('dt');
            dt.className = 'text-[9px] uppercase tracking-wide text-slate-500';
            dt.textContent = term;
            const dd = document.createElement('dd');
            dd.className = 'font-mono text-sm text-slate-800 dark:text-slate-200';
            dd.textContent = value;
            wrap.append(dt, dd);
            return [wrap];
        })
    );
}

/* ------------------------------------------------- corridor-shaped controls */

function accentFor(index) {
    return ARTERIAL_ACCENTS[index % ARTERIAL_ACCENTS.length];
}

function cloneTemplate(id) {
    return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

function buildArterialModeControls() {
    const rows = layout.arterials.map((arterial, index) => {
        const row = cloneTemplate('arterial-mode-template');
        row.querySelector('[data-accent-dot]').style.backgroundColor = accentFor(index);
        row.querySelector('[data-arterial-name]').textContent = arterial.shortName;
        row.querySelector('[data-arterial-meta]').textContent =
            `${arterial.lanes}L · ${arterial.targetSpeedKph} km/h`;

        const control = `arterialMode:${arterial.id}`;
        row.querySelector('[data-segmented-slot]').append(
            cloneSegmented(control, state.arterialModes[arterial.id])
        );

        segmentedHandlers.set(control, (value) => {
            state.arterialModes[arterial.id] = value;
            engine.setArterialMode(arterial.id, value);
            updateStatsModeLabels();
            logChange(control, value);
        });

        return row;
    });

    el.arterialModeControls.replaceChildren(...rows);
}

/**
 * Clones the Blade-rendered `<x-segmented>` in `#segmented-template` and rebinds
 * it to `control`. Cloning rather than rebuilding the markup here is what keeps
 * the light/dark classes in one place - the Blade component - instead of
 * duplicated in a JS string that would silently fall out of step with it.
 */
function cloneSegmented(control, value) {
    const group = cloneTemplate('segmented-template');
    group.dataset.segmented = control;

    group.querySelectorAll('button[data-value]').forEach((button) => {
        button.dataset.control = control;
        const active = button.dataset.value === value;
        button.dataset.active = active ? 'true' : 'false';
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    return group;
}

function buildDemandControls() {
    const entries = [
        ...layout.arterials.map((a) => ({ id: a.id, name: a.shortName, demand: a.demand })),
        ...layout.connectors.map((c) => ({ id: c.id, name: c.name, demand: c.demand })),
    ];

    const rows = entries.map((entry) => (entry.demand.fluctuation ? buildFluctuatingDemandRow(entry) : buildFlatDemandRow(entry)));

    el.demandControls.replaceChildren(...rows);
}

function buildFlatDemandRow(entry) {
    const row = cloneTemplate('demand-row-template');
    row.querySelector('[data-demand-name]').textContent = entry.name;

    const input = row.querySelector('[data-demand-input]');
    const readout = row.querySelector('[data-demand-value]');
    input.value = state.demand[entry.id];
    readout.textContent = state.demand[entry.id];

    input.addEventListener('input', () => {
        state.demand[entry.id] = Number(input.value);
        readout.textContent = input.value;
        engine.setDemand(entry.id, state.demand[entry.id]);
    });
    input.addEventListener('change', () => {
        logChange(`demand:${entry.id}`, `${input.value} veh/lane/min`);
    });

    return row;
}

/** For an id whose corridor config gave it a fluctuation range (corridor.js's buildDemand()) - two handles instead of one, plus a live readout of where the sinusoid actually is right now. */
function buildFluctuatingDemandRow(entry) {
    const row = cloneTemplate('demand-row-fluctuating-template');
    row.querySelector('[data-demand-name]').textContent = entry.name;
    row.dataset.demandId = entry.id;

    const minInput = row.querySelector('[data-demand-min-input]');
    const maxInput = row.querySelector('[data-demand-max-input]');
    const minReadout = row.querySelector('[data-demand-min-value]');
    const maxReadout = row.querySelector('[data-demand-max-value]');

    minInput.value = entry.demand.fluctuation.minPerLanePerMin;
    maxInput.value = entry.demand.fluctuation.maxPerLanePerMin;
    minReadout.textContent = entry.demand.fluctuation.minPerLanePerMin;
    maxReadout.textContent = entry.demand.fluctuation.maxPerLanePerMin;

    const commit = () => {
        const min = Math.min(Number(minInput.value), Number(maxInput.value));
        const max = Math.max(Number(minInput.value), Number(maxInput.value));
        minReadout.textContent = min;
        maxReadout.textContent = max;
        engine.setDemandRange(entry.id, min, max);
    };
    minInput.addEventListener('input', commit);
    maxInput.addEventListener('input', commit);
    minInput.addEventListener('change', () => logChange(`demand:${entry.id}`, `range ${minInput.value}-${maxInput.value} veh/lane/min`));
    maxInput.addEventListener('change', () => logChange(`demand:${entry.id}`, `range ${minInput.value}-${maxInput.value} veh/lane/min`));

    return row;
}

/** Per-frame: the fluctuating rows' "now" readout - purely cosmetic, engine.liveSpawnRate() never touches rng so polling it every frame is safe. */
function updateDemandReadouts() {
    if (!engine) return;
    el.demandControls.querySelectorAll('[data-demand-id]').forEach((row) => {
        const nowEl = row.querySelector('[data-demand-now]');
        if (!nowEl) return;
        const rate = engine.liveSpawnRate(row.dataset.demandId);
        nowEl.textContent = rate == null ? '—' : rate.toFixed(1);
    });
}

function buildStatsColumns() {
    const columns = layout.arterials.map((arterial, index) => {
        const column = cloneTemplate('stats-column-template');
        column.dataset.arterialId = arterial.id;
        column.querySelector('[data-accent-dot]').style.backgroundColor = accentFor(index);
        column.querySelector('[data-arterial-name]').textContent = arterial.shortName;

        const chips = column.querySelector('[data-cleared-chips]');
        const arterialTotalChip = cloneTemplate('cleared-chip-template');
        arterialTotalChip.querySelector('[data-chip-label]').textContent = 'Total';
        arterialTotalChip.dataset.nodeId = ARTERIAL_TOTAL_CHIP_ID;
        chips.replaceChildren(
            ...arterial.intersections.map((node) => {
                const chip = cloneTemplate('cleared-chip-template');
                chip.querySelector('[data-chip-label]').textContent = shortNodeLabel(node);
                chip.dataset.nodeId = node.id;
                return chip;
            }),
            arterialTotalChip
        );

        return column;
    });

    el.statsColumns.replaceChildren(...columns);
    updateStatsModeLabels();
}

/** "Pretorius & Hilda" -> "Hilda": the cross street is what distinguishes them. */
function shortNodeLabel(node) {
    if (node.crossStreetName) return node.crossStreetName.replace(/\s+St$/i, '');
    const parts = node.name.split('&');
    return (parts[1] ?? node.name).trim();
}

function updateStatsModeLabels() {
    el.statsColumns.querySelectorAll('[data-stats-column]').forEach((column) => {
        const mode = state.arterialModes[column.dataset.arterialId];
        const badge = column.querySelector('[data-stat="mode"]');
        if (badge) badge.textContent = MODE_LABELS[mode] ?? mode;
    });
}

/* ------------------------------------------------------- the picked car */

/**
 * The car clicked on the map (2D or 3D): the camera follows it and the car card shows its stats, live; under
 * destination routing the 2D map also draws its route. Cleared by clicking empty map, Esc, the card's close
 * button, or the car leaving the network. Everything here only reads the engine.
 */
let selectedCarId = null;
let followSelected = true;
let carCardRefreshedAtMs = 0;
/** How often the car card's numbers refresh (ms) - often enough to watch, not every frame. */
const CAR_CARD_REFRESH_MS = 200;
/** The car card's name for each vehicle type (car.js's VEHICLE_TYPES). */
const VEHICLE_LABELS = { car: 'Car', truck_small: 'Small truck', truck_medium: 'Medium truck', truck_large: 'Large truck', bus: 'Bus', bmw: 'BMW', ranger: 'Ranger' };

function selectCar(id) {
    selectedCarId = id;
    followSelected = true;
    renderer3d?.setFollowCar(id);
    carCardRefreshedAtMs = 0;
    updateSelectedCar();
    if (activeView === VIEW_2D) renderer.draw();
}

const formatSeconds = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${s.toFixed(1)} s`);

function carCardRow(label, value, valueClass = '') {
    const row = document.createElement('div');
    row.className = 'flex justify-between gap-3';
    const name = document.createElement('span');
    name.className = 'text-slate-500';
    name.textContent = label;
    const text = document.createElement('span');
    text.className = `text-right font-medium text-slate-800 dark:text-slate-100 ${valueClass}`;
    text.textContent = value;
    row.append(name, text);
    return row;
}

function renderCarCard(info) {
    const title = document.createElement('div');
    title.className = 'mb-1.5 flex items-center justify-between gap-2';
    const name = document.createElement('span');
    name.className = 'font-semibold text-slate-900 dark:text-slate-100';
    name.textContent = `${VEHICLE_LABELS[info.vehicleType] ?? info.vehicleType} #${info.id}`;
    const buttons = document.createElement('span');
    buttons.className = 'flex items-center gap-1';
    const follow = document.createElement('button');
    follow.type = 'button';
    follow.dataset.active = followSelected ? 'true' : 'false';
    follow.className = 'rounded border border-slate-300 px-1.5 text-[10px] text-slate-600 data-[active=true]:border-sky-500 data-[active=true]:bg-sky-50 data-[active=true]:text-sky-700 dark:border-slate-700 dark:text-slate-300 dark:data-[active=true]:bg-sky-500/10 dark:data-[active=true]:text-sky-300';
    follow.textContent = followSelected ? 'Following' : 'Follow';
    follow.title = 'Keep the camera on this car';
    follow.addEventListener('click', () => {
        followSelected = !followSelected;
        renderer3d?.setFollowCar(followSelected ? selectedCarId : null);
        carCardRefreshedAtMs = 0;
        updateSelectedCar();
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'rounded px-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800';
    close.textContent = '×';
    close.title = 'Let go of this car (Esc)';
    close.addEventListener('click', () => selectCar(null));
    buttons.append(follow, close);
    title.append(name, buttons);

    const rows = [
        carCardRow('Where', info.roadName),
        carCardRow('Speed', info.stoppedNow ? 'stopped' : `${info.speedKph.toFixed(0)} km/h`, info.stoppedNow ? 'text-rose-600 dark:text-rose-400' : ''),
        carCardRow('Waited so far', `${formatSeconds(info.totalWaitS)}${info.everStopped ? '' : ' (no stops yet)'}`),
    ];
    const { trip } = info;
    if (trip) {
        rows.push(
            carCardRow('From', trip.origin),
            carCardRow('Heading for', trip.destination + (trip.drivewayId ? ` · ${trip.drivewayId}` : '')),
            ...(trip.intendedDestination ? [carCardRow('First meant for', trip.intendedDestination, 'text-amber-600 dark:text-amber-400')] : []),
            carCardRow('Trip time', formatSeconds(trip.tripTimeS)),
            carCardRow('Free-flow trip', formatSeconds(trip.freeFlowS)),
            carCardRow('Delay so far', formatSeconds(trip.delaySoFarS)),
            carCardRow('Share of trip waiting', trip.tripTimeS > 0 ? `${Math.round((info.totalWaitS / trip.tripTimeS) * 100)}%` : '—'),
            carCardRow('Route variant', String(trip.variant)),
            ...(trip.waitingForGap ? [carCardRow('Now', 'waiting for a gap to turn in')] : [])
        );
    } else {
        const note = document.createElement('p');
        note.className = 'mt-1 text-[10px] text-slate-500';
        note.textContent = 'Random turning: this car decides at each junction as it gets there, so it has no destination. Switch on Destination routing to see trips.';
        rows.push(note);
    }
    el.carCard.replaceChildren(title, ...rows);
}

/**
 * Every frame: keep the camera on the picked car, refresh its card now and then, and push its route (and the
 * driveway counts) to the 2D map. A car that has left the network lets go.
 */
function updateSelectedCar() {
    const info = selectedCarId === null || !engine ? null : engine.carInfo(selectedCarId);
    if (selectedCarId !== null && !info) {
        selectedCarId = null;
        renderer3d?.setFollowCar(null);
    }
    el.carCard.classList.toggle('hidden', !info);
    if (info) {
        if (followSelected && activeView === VIEW_2D) renderer.camera.centreOn(info.point, renderer.camera.scale);
        const nowMs = performance.now();
        if (nowMs - carCardRefreshedAtMs >= CAR_CARD_REFRESH_MS) {
            carCardRefreshedAtMs = nowMs;
            renderCarCard(info);
        }
    }

    if (!engine?.routingActive) {
        renderer.setRoutingDebug(info ? { routePreview: null, drivewayCounts: null, selectedPoint: info.point } : {});
        return;
    }
    const routePreview = info ? engine.routePreview(selectedCarId) : null;
    renderer.setRoutingDebug({ routePreview, selectedPoint: info?.point ?? null, drivewayCounts: { in: engine.routingStats.pulledOffByDriveway, out: engine.routingStats.departedByDriveway } });
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selectedCarId !== null) selectCar(null);
});

/** Clicks on the 3D view pick a car too - OrbitControls owns its drags, so only a press and release in one spot counts. */
function watch3dClicks(canvas) {
    let downAt = null;
    canvas.addEventListener('pointerdown', (event) => {
        downAt = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointerup', (event) => {
        if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) <= 4 && event.button === 0) selectCar(renderer3d?.pickCar(event.clientX, event.clientY) ?? null);
        downAt = null;
    });
}

/* ----------------------------------------------------------- camera control */

let dragging = null;
let pointerDownAt = null;

el.canvas.addEventListener('pointerdown', (event) => {
    el.canvas.setPointerCapture(event.pointerId);
    dragging = { x: event.clientX, y: event.clientY };
    pointerDownAt = { x: event.clientX, y: event.clientY };
});

el.canvas.addEventListener('pointermove', (event) => {
    if (dragging) {
        renderer.camera.panByPixels(event.clientX - dragging.x, event.clientY - dragging.y);
        // Panning the map yourself stops following the picked car (its card's Follow button picks it up again).
        if (followSelected && selectedCarId !== null && Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y) > 4) {
            followSelected = false;
            carCardRefreshedAtMs = 0;
        }
        dragging = { x: event.clientX, y: event.clientY };
        renderer.draw();
        return;
    }
    updateHover(event);
});

const endDrag = (event) => {
    if (!dragging) return;
    dragging = null;
    if (el.canvas.hasPointerCapture(event.pointerId)) el.canvas.releasePointerCapture(event.pointerId);
};
el.canvas.addEventListener('pointerup', (event) => {
    // A click (no drag) on the map picks the car under it - or, on empty map, lets go of the picked one.
    if (pointerDownAt && Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y) <= 4) {
        const rect = el.canvas.getBoundingClientRect();
        selectCar(renderer.hitTestCar({ x: event.clientX - rect.left, y: event.clientY - rect.top })?.id ?? null);
    }
    pointerDownAt = null;
    endDrag(event);
});
el.canvas.addEventListener('pointercancel', endDrag);

el.canvas.addEventListener('pointerleave', () => {
    renderer.hoverNodeId = null;
    el.tooltip.classList.add('hidden');
    renderer.draw();
});

el.canvas.addEventListener(
    'wheel',
    (event) => {
        event.preventDefault();
        const rect = el.canvas.getBoundingClientRect();
        const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        renderer.camera.zoomAt(point, Math.exp(-event.deltaY * 0.0015));
        renderer.draw();
    },
    { passive: false }
);

el.canvas.addEventListener('dblclick', (event) => {
    const rect = el.canvas.getBoundingClientRect();
    const node = renderer.hitTestIntersection({ x: event.clientX - rect.left, y: event.clientY - rect.top }, 40);
    if (!node) return;
    renderer.camera.centreOn(node.point, Math.max(renderer.camera.scale, 4.5));
    renderer.draw();
    logChange('camera', `centred on ${node.id}`);
});

function updateHover(event) {
    const rect = el.canvas.getBoundingClientRect();
    const local = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const node = renderer.hitTestIntersection(local);

    if (!node) {
        if (renderer.hoverNodeId !== null) {
            renderer.hoverNodeId = null;
            renderer.draw();
        }
        el.tooltip.classList.add('hidden');
        return;
    }

    if (renderer.hoverNodeId !== node.id) {
        renderer.hoverNodeId = node.id;
        renderer.draw();
    }

    hoveredNode = { node, local, rect };
    renderTooltip();
}

/** The junction under the pointer, for renderFrame() to keep its tooltip (and timing bar) live while the sim runs. */
let hoveredNode = null;

function renderTooltip() {
    if (!hoveredNode || renderer.hoverNodeId !== hoveredNode.node.id) return;
    const { node, local, rect } = hoveredNode;
    const arterial = layout.arterials.find((a) => a.id === node.arterialId);
    const debug = engine?.signalDebugInfo(node.id);
    const v = 'text-slate-800 dark:text-slate-200';
    const row = (label, value, valueClass = v) =>
        `<div class="flex justify-between gap-3"><dt>${label}</dt><dd class="${valueClass}">${value}</dd></div>`;

    el.tooltip.innerHTML = `
        <div class="font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(node.name)}</div>
        <dl class="mt-1.5 space-y-0.5 text-slate-500 dark:text-slate-400">
            ${row('Arterial', escapeHtml(arterial.shortName))}
            ${row('Mode', escapeHtml(MODE_LABELS[state.arterialModes[node.arterialId]]))}
            ${row('Cross street', escapeHtml(node.crossStreetName))}
            ${row('Approaches', node.approaches.length)}
            ${row('To next signal', node.distanceToNextM ? `${node.distanceToNextM} m` : 'end of arterial')}
            ${row('Node id', escapeHtml(node.id), 'font-mono text-slate-400 dark:text-slate-500')}
            ${
                debug
                    ? `<div class="mt-1.5 pt-1.5 border-t border-slate-200 dark:border-slate-700 space-y-0.5">
                        ${row('Signal', escapeHtml(debug.phaseLabel))}
                        ${debug.elapsedS != null ? row('Time in phase', `${debug.elapsedS.toFixed(1)}s`) : ''}
                        ${row('Arterial queue', `${debug.arterialQueue} car${debug.arterialQueue === 1 ? '' : 's'}`)}
                        ${row('Cross queue', `${debug.crossQueue} car${debug.crossQueue === 1 ? '' : 's'}`)}
                        ${row('Next change', escapeHtml(debug.etaLabel))}
                        ${row('Avg wait (last min)', debug.lastMinute?.avgWaitS != null ? `${debug.lastMinute.avgWaitS.toFixed(1)}s` : '—')}
                        ${row('Throughput (last min)', debug.lastMinute ? `${debug.lastMinute.throughput} veh` : '—')}
                    </div>
                    ${signalTimingHtml(debug.timing, arterial.shortName, node.crossStreetName)}`
                    : ''
            }
        </dl>`;
    el.tooltip.classList.remove('hidden');

    // Keep the tooltip inside the canvas box.
    const box = el.tooltip.getBoundingClientRect();
    const left = Math.min(local.x + 14, rect.width - box.width - 8);
    const top = Math.min(local.y + 14, rect.height - box.height - 8);
    el.tooltip.style.left = `${Math.max(8, left)}px`;
    el.tooltip.style.top = `${Math.max(8, top)}px`;
}

const TIMING_FILL = { green: 'fill-emerald-500', arrow: 'fill-teal-300 dark:fill-teal-400', yellow: 'fill-amber-400', red: 'fill-rose-500' };

/**
 * The tooltip's timing bar (engine.js's _signalTiming()). Fixed-time / green wave: one bar per
 * road over the whole cycle, with a cursor at where the junction is in it now. Adaptive: the
 * current green's window - its minimum, then the extension the detectors can stretch it to.
 */
function signalTimingHtml(timing, arterialName, crossName) {
    if (!timing) return '';
    const header = (title, right) =>
        `<div class="mt-1.5 pt-1.5 border-t border-slate-200 dark:border-slate-700 flex justify-between font-medium text-slate-700 dark:text-slate-300"><span>${title}</span><span>${right}</span></div>`;

    if (timing.kind === 'actuated') {
        const road = escapeHtml(timing.phase === 0 ? arterialName : crossName);
        const stage = `${road} ${timing.inTurn ? 'turn arrow' : 'green'}`;
        if (timing.phaseState !== 'green') return header('Actuated stage', `${stage} ending`);
        const { minS, maxS, elapsedS } = timing;
        const x = Math.min(elapsedS, maxS);
        return `${header('Actuated stage', stage)}
            <svg viewBox="0 0 ${maxS} 6" preserveAspectRatio="none" class="mt-1 block h-2.5 w-full overflow-hidden rounded-sm">
                <rect x="0" y="0" width="${minS}" height="6" class="${timing.inTurn ? TIMING_FILL.arrow : TIMING_FILL.green}" />
                <rect x="${minS}" y="0" width="${maxS - minS}" height="6" class="fill-emerald-500/30" />
                <rect x="0" y="0" width="${x}" height="6" class="fill-slate-900/25 dark:fill-white/25" />
                <line x1="${x}" x2="${x}" y1="0" y2="6" vector-effect="non-scaling-stroke" stroke-width="2" class="stroke-slate-900 dark:stroke-white" />
            </svg>
            <div class="mt-0.5 flex justify-between text-[10px] text-slate-500 dark:text-slate-400">
                <span>${elapsedS.toFixed(1)}s · min ${minS.toFixed(0)}s</span>
                <span>gap-out ${timing.gapOutS}s · max ${maxS.toFixed(0)}s</span>
            </div>`;
    }

    const { cycleS, positionS, roads } = timing;
    const bar = (runs) => {
        let x = 0;
        const rects = runs
            .map((run) => {
                const rect = `<rect x="${x}" y="0" width="${run.durationS}" height="6" class="${TIMING_FILL[run.state]}" />`;
                x += run.durationS;
                return rect;
            })
            .join('');
        return `<svg viewBox="0 0 ${cycleS} 6" preserveAspectRatio="none" class="block h-2.5 w-full overflow-hidden rounded-sm">
                ${rects}
                <line x1="${positionS}" x2="${positionS}" y1="0" y2="6" vector-effect="non-scaling-stroke" stroke-width="2" class="stroke-slate-900 dark:stroke-white" />
            </svg>`;
    };
    const totals = (runs) => {
        const sum = (states) => runs.filter((r) => states.includes(r.state)).reduce((s, r) => s + r.durationS, 0);
        const arrow = sum(['arrow']);
        return [
            `<span class="text-emerald-600 dark:text-emerald-400">${Math.round(sum(['green']))}s green</span>`,
            ...(arrow ? [`<span class="text-teal-600 dark:text-teal-300">${Math.round(arrow)}s arrow</span>`] : []),
            `<span class="text-amber-600 dark:text-amber-400">${Math.round(sum(['yellow']))}s amber</span>`,
            `<span class="text-rose-600 dark:text-rose-400">${Math.round(sum(['red']))}s red</span>`,
        ].join(' · ');
    };
    const roadRow = (label, runs) => `
        <div class="mt-1">
            <div class="flex justify-between text-[10px]"><span class="text-slate-600 dark:text-slate-300">${label}</span><span>${totals(runs)}</span></div>
            <div class="mt-0.5">${bar(runs)}</div>
        </div>`;

    return `${header('Cycle timing', `${positionS.toFixed(0)} / ${Math.round(cycleS)}s`)}
        ${roadRow(escapeHtml(arterialName), roads[0])}
        ${roadRow(escapeHtml(crossName), roads[1])}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

document.getElementById('zoom-in').addEventListener('click', () => zoomButton(1.35));
document.getElementById('zoom-out').addEventListener('click', () => zoomButton(1 / 1.35));
document.getElementById('zoom-fit').addEventListener('click', () => activeRenderer().fit());

function zoomButton(factor) {
    const { width, height } = renderer.camera.viewport;
    renderer.camera.zoomAt({ x: width / 2, y: height / 2 }, factor);
    renderer.draw();
}

document.querySelectorAll('input[data-layer]').forEach((input) => {
    input.addEventListener('change', () => {
        renderer.setOptions({ [input.dataset.layer]: input.checked });
        renderer.draw();
        logChange(`layer:${input.dataset.layer}`, input.checked);
    });
});

new ResizeObserver(() => activeRenderer().resize()).observe(el.canvasWrap);

/*
 * Full screen puts #sim-stage (transport bar + canvas + stats footer) into browser full screen.
 * The ResizeObserver above already resizes whichever renderer is active, and
 * Esc exits natively - fullscreenchange keeps data-fullscreen in sync either way.
 */
const simStage = document.getElementById('sim-stage');

document.getElementById('fullscreen-enter').addEventListener('click', () => {
    simStage.requestFullscreen().catch((error) => {
        // eslint-disable-next-line no-console
        console.warn('Full screen was refused:', error);
    });
});
document.getElementById('fullscreen-exit').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
});
document.addEventListener('fullscreenchange', () => {
    simStage.dataset.fullscreen = String(document.fullscreenElement === simStage);
});

/* ----------------------------------------------------------- other controls */

el.corridorSelect.addEventListener('change', async () => {
    const requested = el.corridorSelect.value;
    try {
        await loadCorridor(requested);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(error);
        showCorridorError(error.message);
        // Put the picker back on whatever is actually drawn, so the control does
        // not claim to be showing a corridor that failed to load.
        el.corridorSelect.value = state.corridorId;
        logChange('corridor', `FAILED to load ${requested}: ${error.message}`);
    }
});

function showCorridorError(message) {
    if (!el.corridorError) return;
    el.corridorErrorMessage.textContent = message;
    el.corridorError.classList.remove('hidden');
}

function clearCorridorError() {
    el.corridorError?.classList.add('hidden');
}

/** Full restart at t=0 with the current seed/config - shared by Reset, seed change and seed randomise. */
function restartEngine() {
    engine.reset(engineResetOptions());
    syncDriveways();
    accumulatorS = 0;
    lastFrameMs = null;
    // Any in-flight replay's outage-scheduling bookkeeping no longer applies once the engine
    // has been reset out from under it (manually, via seed/corridor change, or by a new replay).
    // `pauseAfterCatchUp` is reset defensively too, in case a replay's warm-up catch-up was
    // interrupted by a Reset before it could consume (and restore) the flag itself.
    replay = null;
    pauseAfterCatchUp = true;
    buildFooterChart();
    resetRunState();
}

el.seedInput.addEventListener('change', () => {
    state.seed = Number(el.seedInput.value);
    restartEngine();
    logChange('seed', state.seed);
});

el.seedRandomise.addEventListener('click', () => {
    // Picking a seed is not itself stochastic simulation input - every in-sim
    // draw (spawn timing, cross-routing, sprite pick) goes through rng.js.
    state.seed = Math.floor(Math.random() * 2 ** 31);
    el.seedInput.value = state.seed;
    restartEngine();
    logChange('seed', state.seed);
});

document.querySelectorAll('input[name="sensorMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
        if (!radio.checked) return;
        state.sensorMode = radio.value;
        engine.setSensorMode(radio.value);
        el.sensorPillLabel.textContent = SENSOR_LABELS[radio.value];
        logChange('sensorMode', radio.value);
    });
});

el.truckRatioInput.addEventListener('input', () => {
    state.truckRatio = Number(el.truckRatioInput.value) / 100;
    el.truckRatioValue.textContent = el.truckRatioInput.value;
    engine.setTruckRatio(state.truckRatio);
});
el.truckRatioInput.addEventListener('change', () => {
    logChange('truckRatio', `${el.truckRatioInput.value}%`);
});

el.busRatioInput.addEventListener('input', () => {
    state.busRatio = Number(el.busRatioInput.value) / 100;
    el.busRatioValue.textContent = el.busRatioInput.value;
    engine.setBusRatio(state.busRatio);
});
el.busRatioInput.addEventListener('change', () => {
    logChange('busRatio', `${el.busRatioInput.value}%`);
});

el.randomEventsInput.addEventListener('change', () => {
    state.randomEvents = el.randomEventsInput.checked;
    engine.setRandomEvents(state.randomEvents);
    logChange('randomEvents', state.randomEvents);
});

// Trips are assigned as cars spawn, so switching routing restarts the run.
el.destinationRoutingInput.addEventListener('change', () => {
    state.routingMode = el.destinationRoutingInput.checked ? 'destination' : 'random';
    restartEngine();
    logChange('routingMode', state.routingMode);
    fetchSampleRuns(state.corridorId); // the replay picker offers that routing mode's latest batch
});

document.getElementById('battery-backed-sensors').addEventListener('change', (event) => {
    state.batteryBackedSensors = event.target.checked;
    engine.setBatteryBackedSensors(event.target.checked);
    logChange('batteryBackedSensors', state.batteryBackedSensors);
});

function syncPowerSchedule() {
    engine.setPowerSchedule({
        scheduledOutages: state.power.scheduledOutages,
        offMinutes: state.power.offMinutes,
        periodMinutes: state.power.periodMinutes,
    });
}

document.getElementById('scheduled-outages').addEventListener('change', (event) => {
    state.power.scheduledOutages = event.target.checked;
    syncPowerSchedule();
    logChange('power.scheduledOutages', state.power.scheduledOutages);
});

document.getElementById('outage-off-minutes').addEventListener('change', (event) => {
    state.power.offMinutes = Number(event.target.value);
    syncPowerSchedule();
    logChange('power.offMinutes', state.power.offMinutes);
});

document.getElementById('outage-period-minutes').addEventListener('change', (event) => {
    state.power.periodMinutes = Number(event.target.value);
    syncPowerSchedule();
    logChange('power.periodMinutes', state.power.periodMinutes);
});

el.loadSheddingToggle.addEventListener('click', () => {
    state.power.loadShedding = !state.power.loadShedding;
    applyToggleFaces(el.loadSheddingToggle, state.power.loadShedding);
    engine.setManualLoadShedding(state.power.loadShedding);
    renderPowerPill(state.power.loadShedding);
    logChange('power.loadShedding', state.power.loadShedding);
});

/**
 * Loads and plays a batch-dataset run: forces every control to the run's recorded conditions
 * (uniform controller mode across all arterials, its sensor, seed, and the batch defaults the
 * live page doesn't otherwise apply - 0% trucks and buses, random events off, battery-backed sensors on, no scheduled
 * outages), then hands off to `tickEngine()` (via `replay`) to reset stats at the end of
 * warm-up and trigger/restore power automatically at the run's original outage ticks.
 */
async function startReplay(run) {
    if (run.corridor_config !== state.corridorId) {
        await loadCorridor(run.corridor_config);
        el.corridorSelect.value = run.corridor_config;
    }

    state.seed = run.seed;
    el.seedInput.value = state.seed;

    if (run.sensor_mode) {
        state.sensorMode = run.sensor_mode;
        const radio = document.querySelector(`input[name="sensorMode"][value="${run.sensor_mode}"]`);
        if (radio) radio.checked = true;
        el.sensorPillLabel.textContent = SENSOR_LABELS[run.sensor_mode] ?? run.sensor_mode;
    }

    state.truckRatio = 0;
    el.truckRatioInput.value = 0;
    el.truckRatioValue.textContent = '0';

    state.busRatio = 0;
    el.busRatioInput.value = 0;
    el.busRatioValue.textContent = '0';

    state.randomEvents = false;
    el.randomEventsInput.checked = false;

    state.routingMode = layout.routing && run.routing_mode === 'destination' ? 'destination' : 'random';
    el.destinationRoutingInput.checked = state.routingMode === 'destination';

    state.batteryBackedSensors = true;
    document.getElementById('battery-backed-sensors').checked = true;

    // Outage timing is driven by tickEngine() below, not the manual toggle - start clean.
    state.power = {
        loadShedding: false,
        scheduledOutages: false,
        offMinutes: state.power.offMinutes,
        periodMinutes: state.power.periodMinutes,
    };
    document.getElementById('scheduled-outages').checked = false;
    applyToggleFaces(el.loadSheddingToggle, false);

    // Batch runs apply one controller mode to every arterial (see runHeadless.js) - the live
    // page's default is per-arterial, so this has to be forced, not just left to whatever the
    // corridor's own default happened to be.
    for (const arterial of layout.arterials) {
        state.arterialModes[arterial.id] = run.controller_mode;
    }
    buildArterialModeControls();

    restartEngine(); // real engine.reset() with all of the above now in `state`

    const config = run.raw_config_json ?? {};
    const warmupTicks = config.warmupTicks ?? 0;
    replay = {
        ticks: 0,
        warmupTicks,
        statsReset: warmupTicks <= 0,
        powerOutageStartTick: config.powerOutageStartTick ?? null,
        powerOutageEndTick: config.powerOutageEndTick ?? null,
        durationTicks: config.durationTicks ?? Infinity,
        outageStarted: false,
        outageEnded: false,
    };

    if (warmupTicks > 0) {
        // Reuse the "Run to t=1000s" catch-up mechanism to blast through warm-up silently -
        // tickEngine() still runs on every one of those ticks, so stats-reset fires at the
        // right moment even though playback hasn't visibly started yet.
        runUntilS = warmupTicks * FIXED_DT_S;
        pauseAfterCatchUp = false;
    }

    state.running = true;
    applyToggleFaces(el.runToggle, true);
    renderRunPill();

    const label = replayFamilyLabel(run);
    const powerLabel = run.power_state === 'load_shedding' ? 'with load shedding' : 'without load shedding';
    if (el.replayStatus) el.replayStatus.textContent = `Replaying ${label}, ${powerLabel} (seed ${state.seed}).`;
    logChange('replay', `${label} - ${powerLabel} (seed ${state.seed})`);
}

el.replayLoadButton?.addEventListener('click', async () => {
    const familyKey = el.replayFamilySelect.value;
    const run = sampleRuns.find((r) => replayFamilyKey(r) === familyKey && r.power_state === replaySelectedPowerState);
    if (!run) {
        if (el.replayStatus) {
            el.replayStatus.textContent = `No ${replaySelectedPowerState === 'load_shedding' ? 'load-shedding' : 'normal-power'} run found for this condition.`;
        }
        return;
    }

    el.replayLoadButton.disabled = true;
    try {
        await startReplay(run);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Replay failed to start', error);
        if (el.replayStatus) el.replayStatus.textContent = `Replay failed: ${error.message}`;
    } finally {
        el.replayLoadButton.disabled = false;
    }
});

el.runToggle.addEventListener('click', () => {
    runUntilS = null;
    state.running = !state.running;
    applyToggleFaces(el.runToggle, state.running);
    renderRunPill();
    logChange('running', state.running);
});

el.stepButton.addEventListener('click', () => {
    runUntilS = null;
    tickEngine();
    renderFrame(engine.snapshot());
    logChange('step', `advanced ${FIXED_DT_S}s`);
});

const RUN_TO_TIME_TARGET_S = 1000;

el.runToTimeButton.addEventListener('click', () => {
    if (engine.simTimeS >= RUN_TO_TIME_TARGET_S) return;
    runUntilS = RUN_TO_TIME_TARGET_S;
    pauseAfterCatchUp = true;
    state.running = true;
    applyToggleFaces(el.runToggle, true);
    renderRunPill();
    logChange('running', `catching up to t=${RUN_TO_TIME_TARGET_S}s`);
});

el.resetButton.addEventListener('click', () => {
    runUntilS = null;
    state.running = false;
    applyToggleFaces(el.runToggle, false);
    restartEngine();
    renderer.fit();
    renderer3d?.fit();
    logChange('reset', 'scenario reset');
});

/** Flips a button's `data-active` state and swaps its two label faces. */
function applyToggleFaces(button, active) {
    button.dataset.active = active ? 'true' : 'false';
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.querySelector('[data-when-inactive]')?.classList.toggle('hidden', active);
    button.querySelector('[data-when-active]')?.classList.toggle('hidden', !active);
}

function renderRunPill() {
    const tone = state.running ? 'emerald' : 'neutral';
    el.runStatePill.className = PILL_TONES[tone];
    el.runStatePill.querySelector('span').className = DOT_TONES[tone];
    el.runStateLabel.textContent = state.running ? 'Running' : 'Idle';
}

/**
 * `effectiveLoadShedding` is the engine's actual power state, not the manual
 * toggle's own on/off - a scheduled rotating outage can put the network into
 * load shedding even while the manual button still reads "off", so this pill
 * has to reflect what is really happening, not just what was clicked.
 */
function renderPowerPill(effectiveLoadShedding) {
    const tone = effectiveLoadShedding ? 'rose' : 'emerald';
    el.powerPill.className = PILL_TONES[tone];
    el.powerPill.querySelector('span').className = DOT_TONES[tone];
    el.powerLabel.textContent = effectiveLoadShedding ? 'Load shedding' : 'Power normal';
}

/** Clears every stat readout back to the em-dash placeholder. */
function resetRunState() {
    el.simClock.textContent = '00:00.0';
    el.statsColumns.querySelectorAll('[data-stat]').forEach((node) => {
        if (node.dataset.stat !== 'mode') node.textContent = '—';
    });
    el.statsColumns.querySelectorAll('[data-chip-value]').forEach((node) => {
        node.textContent = '—';
    });
    renderRunPill();
    updateStatsModeLabels();
}

/* ------------------------------------------------------------- footer chart */

/**
 * The live throughput chart. `appendChartSampleIfNeeded()` below feeds it a
 * point per arterial every 0.5 sim-seconds from `engine.js`'s cumulative
 * cleared-vehicle count, so the line's slope reads as throughput.
 *
 * Rebuilt whenever the corridor changes - the series are the arterials, so a
 * different corridor means a different legend.
 */
function buildFooterChart() {
    const canvas = document.getElementById('stats-chart');
    if (footerChart) {
        footerChart.destroy();
        footerChart = null;
    }
    const options = baseOptions({
        tickFormat: (v) => `${v}`,
        xTitle: '',
    });
    options.layout.padding.top = 10;
    options.scales.y.suggestedMin = 0;
    options.plugins.legend = {
        display: true,
        position: 'bottom',
        labels: {
            boxWidth: 8,
            boxHeight: 8,
            usePointStyle: true,
            pointStyle: 'circle',
            color: INK.secondary,
            padding: 12,
        },
    };

    footerChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                ...(layout?.arterials ?? []).map((arterial, index) =>
                    lineDataset({ label: arterial.shortName, data: [], colour: accentFor(index) })
                ),
                // All arterials summed - appended last so appendChartSampleIfNeeded()
                // can find it by index without a label lookup.
                lineDataset({ label: 'Total', data: [], colour: INK.muted }),
            ],
        },
        options,
    });

    lastChartSampleCount = 0;
    el.statsChartEmpty?.classList.remove('hidden');

    return footerChart;
}

/** Pushes fresh chart points only when the engine actually produced new samples this frame. */
function appendChartSampleIfNeeded(snapshot) {
    if (!footerChart || !layout) return;

    const totalSamples = layout.arterials.reduce((n, a) => n + (snapshot.stats[a.id]?.chartSamples.length ?? 0), 0);
    if (totalSamples === lastChartSampleCount) return;
    lastChartSampleCount = totalSamples;

    // Labelled in elapsed seconds, not sample index - the sample count keeps
    // growing for the life of the run, so a raw index reads as if the chart
    // had stalled once autoSkip starts hiding most of the ticks.
    const perArterialSamples = layout.arterials.map((a) => snapshot.stats[a.id]?.chartSamples ?? []);
    const first = perArterialSamples[0] ?? [];
    footerChart.data.labels = first.map((_, i) => `${i * CHART_SAMPLE_INTERVAL_S}`);
    footerChart.data.datasets.forEach((dataset, index) => {
        // The 'Total' dataset is appended after one per arterial - see buildFooterChart().
        dataset.data =
            index < perArterialSamples.length
                ? perArterialSamples[index].slice()
                : first.map((_, i) => perArterialSamples.reduce((sum, samples) => sum + (samples[i] ?? 0), 0));
    });
    footerChart.update('none');
    el.statsChartEmpty?.classList.toggle('hidden', totalSamples > 0);
}

/* -------------------------------------------------------------- render loop */

const fmtSeconds = (s) => `${s.toFixed(1)}s`;

function updateSimClock(simTimeS) {
    const totalTenths = Math.floor(simTimeS * 10);
    const mm = Math.floor(totalTenths / 600);
    const ss = Math.floor((totalTenths % 600) / 10);
    const tenths = totalTenths % 10;
    el.simClock.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${tenths}`;
}

function setStat(column, name, text) {
    const node = column.querySelector(`[data-stat="${name}"]`);
    if (node) node.textContent = text;
}

function updateStatsFooter(snapshot) {
    el.statsColumns.querySelectorAll('[data-stats-column]').forEach((column) => {
        const arterialId = column.dataset.arterialId;
        const stats = snapshot.stats[arterialId];
        if (!stats) return;

        setStat(column, 'avgWaitNow', fmtSeconds(stats.avgWaitNow));
        setStat(column, 'avgWaitRolling', fmtSeconds(stats.avgWaitRolling));
        setStat(column, 'throughput', String(stats.throughputPerMin));
        setStat(column, 'onRoad', String(stats.onRoad));
        setStat(
            column,
            'clearedWithoutStop',
            stats.clearedWithoutStopPct == null ? '—' : `${Math.round(stats.clearedWithoutStopPct)}%`
        );

        // Precise cumulative counts straight from the engine's own bookkeeping,
        // not a sensor reading - unlike the queue chips these used to be, power
        // cuts never blank these. The arterial's own "Total" chip is the whole
        // road's clear count (clearedTotal), not a per-intersection section.
        column.querySelectorAll('[data-cleared-chips] > [data-node-id]').forEach((chipEl) => {
            const valueEl = chipEl.querySelector('[data-chip-value]');
            if (!valueEl) return;
            const nodeId = chipEl.dataset.nodeId;
            const value = nodeId === ARTERIAL_TOTAL_CHIP_ID ? stats.clearedTotal : stats.clearedByNode[nodeId];
            valueEl.textContent = value == null ? '—' : String(value);
        });
    });
}

/** One frame: push the engine's latest state into the canvas, footer stats and chart. */
function renderFrame(snapshot) {
    updateSelectedCar();
    // alpha = progress towards the next tick; the 2D map ignores it, the 3D view interpolates with it.
    activeRenderer().update(snapshot, accumulatorS / FIXED_DT_S);
    updateStatsFooter(snapshot);
    updateSimClock(snapshot.simTimeS);
    renderPowerPill(snapshot.powerState === 'load_shedding');
    appendChartSampleIfNeeded(snapshot);
    updateDemandReadouts();
    if (!el.tooltip.classList.contains('hidden')) renderTooltip();
}

/**
 * Fixed-timestep accumulator: physics always advances in FIXED_DT_S chunks
 * regardless of the browser's actual frame rate, so the same engine (build
 * step 13's headless runner included) behaves identically no matter how fast
 * it is drawn. `state.speed` scales how much sim time one real second buys.
 */
function animate(nowMs) {
    rafId = requestAnimationFrame(animate);

    if (lastFrameMs === null) {
        lastFrameMs = nowMs;
        renderFrame(engine.snapshot());
        return;
    }

    const realDtS = Math.min((nowMs - lastFrameMs) / 1000, 0.25);
    lastFrameMs = nowMs;

    if (state.running && runUntilS !== null) {
        const frameDeadlineMs = nowMs + RUN_TO_TIME_FRAME_BUDGET_MS;
        while (engine.simTimeS < runUntilS && performance.now() < frameDeadlineMs) {
            tickEngine();
        }
        if (engine.simTimeS >= runUntilS) {
            runUntilS = null;
            // The manual "Run to t=1000s" button always stops here; a replay's silent
            // warm-up fast-forward instead hands off to normal speed-based playback below.
            if (pauseAfterCatchUp) {
                state.running = false;
                applyToggleFaces(el.runToggle, false);
                renderRunPill();
                logChange('running', false);
            }
            pauseAfterCatchUp = true;
        }
    } else if (state.running) {
        accumulatorS += realDtS * state.speed;
        let steps = 0;
        while (accumulatorS >= FIXED_DT_S && steps < 50) {
            tickEngine();
            accumulatorS -= FIXED_DT_S;
            steps += 1;
        }
    }

    renderFrame(engine.snapshot());
}

/**
 * Every engine tick goes through here, not just `engine.tick()` directly, so a replay's
 * schedule-driven side effects (stats reset at the end of warm-up, automatic outage
 * trigger/restore, auto-stop at the recorded run's end) apply identically whether the tick
 * came from normal speed-based playback, the "Run to t=1000s"-style catch-up loop, or the
 * Step button. Mirrors runHeadless.js's own measuredTick bookkeeping (see its main loop)
 * exactly, so a replayed run reaches the same stats-reset/outage timing the batch data itself
 * was measured against.
 */
function tickEngine() {
    engine.tick(FIXED_DT_S);
    if (!replay) return;

    replay.ticks += 1;
    const measuredTick = replay.ticks - replay.warmupTicks;

    if (!replay.statsReset && measuredTick >= 0) {
        engine.resetStats();
        replay.statsReset = true;
        logChange('replay', 'warm-up complete, stats reset');
    }

    if (replay.powerOutageStartTick != null && !replay.outageStarted && measuredTick >= replay.powerOutageStartTick) {
        replay.outageStarted = true;
        state.power.loadShedding = true;
        applyToggleFaces(el.loadSheddingToggle, true);
        engine.setManualLoadShedding(true);
        logChange('replay', 'power outage triggered (matches recorded run)');
    }

    if (replay.powerOutageEndTick != null && replay.outageStarted && !replay.outageEnded && measuredTick >= replay.powerOutageEndTick) {
        replay.outageEnded = true;
        state.power.loadShedding = false;
        applyToggleFaces(el.loadSheddingToggle, false);
        engine.setManualLoadShedding(false);
        logChange('replay', 'power restored (matches recorded run)');
    }

    if (measuredTick >= replay.durationTicks) {
        replay = null;
        runUntilS = null;
        state.running = false;
        applyToggleFaces(el.runToggle, false);
        renderRunPill();
        logChange('replay', 'reached end of recorded run - paused');
    }
}

/* --------------------------------------------------------------------- boot */

(async function start() {
    // Runs immediately with the current theme, then again on every toggle. The
    // canvas and the chart both paint their own colours, so neither can be left
    // behind by a CSS-only theme switch.
    let firstThemeCall = true;
    onThemeChange((theme) => {
        currentTheme = theme;
        renderer2d.setTheme(theme);
        renderer3d?.setTheme(theme);
        applyChartTheme(theme);
        if (!firstThemeCall) buildFooterChart();
        firstThemeCall = false;
    });

    try {
        await loadCorridor(boot.defaultCorridorId, { config: boot.defaultCorridor });
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Corridor failed to load', error);
        showCorridorError(error.message);
    }

    renderRunPill();
    rafId = requestAnimationFrame(animate);
})();
