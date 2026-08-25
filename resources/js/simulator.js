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

import { buildLayout } from './sim/corridor.js';
import { LayoutRenderer, ARTERIAL_ACCENTS } from './sim/renderer.js';
import { SimulationEngine, CHART_SAMPLE_INTERVAL_S } from './sim/engine.js';
import { Chart, INK, applyChartTheme, baseOptions, lineDataset } from './charts/theme.js';
import { onThemeChange } from './theme.js';

/** Physics timestep - decoupled from render framerate so batch mode (build step 13) reuses the same engine unmodified. */
const FIXED_DT_S = 0.1;

/** Sentinel node id for the arterial-wide "Total" chip appended to the per-intersection cleared-by-road-section chips. */
const ARTERIAL_TOTAL_CHIP_ID = 'arterial-total';

const boot = JSON.parse(document.getElementById('sim-boot').textContent);

const MODE_LABELS = {
    fixed: 'Fixed-time',
    adaptive: 'Adaptive',
    green_wave: 'Green wave',
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

const el = {
    canvasWrap: document.getElementById('canvas-wrap'),
    simClock: document.getElementById('sim-clock'),
    statsChartEmpty: document.getElementById('stats-chart-empty'),
    canvas: document.getElementById('sim-canvas'),
    tooltip: document.getElementById('node-tooltip'),
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
    statsColumns: document.getElementById('stats-columns'),
    runToggle: document.getElementById('run-toggle'),
    stepButton: document.getElementById('step-button'),
    runToTimeButton: document.getElementById('run-to-time-button'),
    resetButton: document.getElementById('reset-button'),
    loadSheddingToggle: document.getElementById('load-shedding-toggle'),
    runStatePill: document.getElementById('run-state-pill'),
    runStateLabel: document.getElementById('run-state-label'),
    powerPill: document.getElementById('power-pill'),
    powerLabel: document.getElementById('power-label'),
    sensorPillLabel: document.getElementById('sensor-pill-label'),
    controlLog: document.getElementById('control-log'),
};

const renderer = new LayoutRenderer(el.canvas);

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
    renderer.setLayout(layout);
    renderCorridorSummary();
    buildArterialModeControls();
    buildDemandControls();
    buildStatsColumns();
    buildFooterChart();

    // A different corridor means different nodes/arterials, so the engine
    // (which precomputes stop-line distances per node at construction time)
    // has to be rebuilt from scratch, not just reset.
    engine = new SimulationEngine(layout);
    engine.reset(engineResetOptions());
    accumulatorS = 0;

    resetRunState();

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
    };
}

async function fetchCorridor(id) {
    const url = boot.corridorUrlTemplate.replace('__ID__', encodeURIComponent(id));
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
        throw new Error(`Failed to load corridor "${id}" (HTTP ${response.status}).`);
    }
    return response.json();
}

function renderCorridorSummary() {
    el.corridorDescription.textContent = layout.description || '';

    const intersections = layout.arterials.reduce((sum, a) => sum + a.intersections.length, 0);
    const facts = [
        ['Arterials', layout.arterials.length],
        ['Signals', intersections],
        ['Cross-streets', layout.connectors.length],
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

/* ----------------------------------------------------------- camera control */

let dragging = null;

el.canvas.addEventListener('pointerdown', (event) => {
    el.canvas.setPointerCapture(event.pointerId);
    dragging = { x: event.clientX, y: event.clientY };
});

el.canvas.addEventListener('pointermove', (event) => {
    if (dragging) {
        renderer.camera.panByPixels(event.clientX - dragging.x, event.clientY - dragging.y);
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
el.canvas.addEventListener('pointerup', endDrag);
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
                    </div>`
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

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

document.getElementById('zoom-in').addEventListener('click', () => zoomButton(1.35));
document.getElementById('zoom-out').addEventListener('click', () => zoomButton(1 / 1.35));
document.getElementById('zoom-fit').addEventListener('click', () => renderer.fit());

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

new ResizeObserver(() => renderer.resize()).observe(el.canvasWrap);

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
    accumulatorS = 0;
    lastFrameMs = null;
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

el.runToggle.addEventListener('click', () => {
    runUntilS = null;
    state.running = !state.running;
    applyToggleFaces(el.runToggle, state.running);
    renderRunPill();
    logChange('running', state.running);
});

el.stepButton.addEventListener('click', () => {
    runUntilS = null;
    engine.tick(FIXED_DT_S);
    renderFrame(engine.snapshot());
    logChange('step', `advanced ${FIXED_DT_S}s`);
});

const RUN_TO_TIME_TARGET_S = 1000;

el.runToTimeButton.addEventListener('click', () => {
    if (engine.simTimeS >= RUN_TO_TIME_TARGET_S) return;
    runUntilS = RUN_TO_TIME_TARGET_S;
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
    renderer.setDynamicState({ cars: snapshot.cars, signals: snapshot.signals });
    renderer.draw();
    updateStatsFooter(snapshot);
    updateSimClock(snapshot.simTimeS);
    renderPowerPill(snapshot.powerState === 'load_shedding');
    appendChartSampleIfNeeded(snapshot);
    updateDemandReadouts();
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
            engine.tick(FIXED_DT_S);
        }
        if (engine.simTimeS >= runUntilS) {
            runUntilS = null;
            state.running = false;
            applyToggleFaces(el.runToggle, false);
            renderRunPill();
            logChange('running', false);
        }
    } else if (state.running) {
        accumulatorS += realDtS * state.speed;
        let steps = 0;
        while (accumulatorS >= FIXED_DT_S && steps < 50) {
            engine.tick(FIXED_DT_S);
            accumulatorS -= FIXED_DT_S;
            steps += 1;
        }
    }

    renderFrame(engine.snapshot());
}

/* --------------------------------------------------------------------- boot */

(async function start() {
    // Runs immediately with the current theme, then again on every toggle. The
    // canvas and the chart both paint their own colours, so neither can be left
    // behind by a CSS-only theme switch.
    let firstThemeCall = true;
    onThemeChange((theme) => {
        renderer.setTheme(theme);
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
