/**
 * /simulator page script - PHASE 1.
 *
 * What this file does:
 *   - loads a corridor layout config and draws it (corridor.js -> renderer.js)
 *   - runs the camera: drag to pan, wheel to zoom, double-click to centre
 *   - builds the controls that depend on the loaded corridor (per-arterial mode
 *     selectors, demand sliders, stats-footer columns)
 *   - holds the control state, reflects it in the UI, and logs every change
 *
 * What this file deliberately does NOT do: step time. There is no
 * requestAnimationFrame loop, no timer and no simulation state. `Run` flips a UI
 * flag and nothing else. Build steps 6-14 attach the real engine behind these
 * same controls; this file's job is to prove the surface is right first.
 */

import { buildLayout } from './sim/corridor.js';
import { LayoutRenderer, ARTERIAL_ACCENTS } from './sim/renderer.js';
import { Chart, INK, applyChartTheme, baseOptions, lineDataset } from './charts/theme.js';
import { onThemeChange } from './theme.js';

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
    connectorMode: 'fixed',
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
};

let layout = null;

const el = {
    canvasWrap: document.getElementById('canvas-wrap'),
    canvas: document.getElementById('sim-canvas'),
    tooltip: document.getElementById('node-tooltip'),
    corridorSelect: document.getElementById('corridor-select'),
    corridorDescription: document.getElementById('corridor-description'),
    corridorFacts: document.getElementById('corridor-facts'),
    seedInput: document.getElementById('seed-input'),
    seedRandomise: document.getElementById('seed-randomise'),
    arterialModeControls: document.getElementById('arterial-mode-controls'),
    demandControls: document.getElementById('demand-controls'),
    statsColumns: document.getElementById('stats-columns'),
    runToggle: document.getElementById('run-toggle'),
    stepButton: document.getElementById('step-button'),
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

segmentedHandlers.set('connectorMode', (value) => {
    state.connectorMode = value;
    logChange('connectorMode', value);
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

    renderer.setLayout(layout);
    renderCorridorSummary();
    buildArterialModeControls();
    buildDemandControls();
    buildStatsColumns();
    buildFooterChart();
    resetRunState();

    logChange('corridor', `${id} (${layout.arterials.length} arterials, ${layout.connectors.length} connectors)`);
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
        ...layout.arterials.map((a) => ({ id: a.id, name: a.shortName })),
        ...layout.connectors.map((c) => ({ id: c.id, name: c.name })),
    ];

    const rows = entries.map((entry) => {
        const row = cloneTemplate('demand-row-template');
        row.querySelector('[data-demand-name]').textContent = entry.name;

        const input = row.querySelector('[data-demand-input]');
        const readout = row.querySelector('[data-demand-value]');
        input.value = state.demand[entry.id];
        readout.textContent = state.demand[entry.id];

        input.addEventListener('input', () => {
            state.demand[entry.id] = Number(input.value);
            readout.textContent = input.value;
        });
        input.addEventListener('change', () => {
            logChange(`demand:${entry.id}`, `${input.value} veh/lane/min`);
        });

        return row;
    });

    el.demandControls.replaceChildren(...rows);
}

function buildStatsColumns() {
    const columns = layout.arterials.map((arterial, index) => {
        const column = cloneTemplate('stats-column-template');
        column.dataset.arterialId = arterial.id;
        column.querySelector('[data-accent-dot]').style.backgroundColor = accentFor(index);
        column.querySelector('[data-arterial-name]').textContent = arterial.shortName;

        const chips = column.querySelector('[data-queue-chips]');
        chips.replaceChildren(
            ...arterial.intersections.map((node) => {
                const chip = cloneTemplate('queue-chip-template');
                chip.querySelector('[data-chip-label]').textContent = shortNodeLabel(node);
                chip.dataset.nodeId = node.id;
                return chip;
            })
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
    const v = 'text-slate-800 dark:text-slate-200';
    el.tooltip.innerHTML = `
        <div class="font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(node.name)}</div>
        <dl class="mt-1.5 space-y-0.5 text-slate-500 dark:text-slate-400">
            <div class="flex justify-between gap-3"><dt>Arterial</dt><dd class="${v}">${escapeHtml(arterial.shortName)}</dd></div>
            <div class="flex justify-between gap-3"><dt>Mode</dt><dd class="${v}">${escapeHtml(MODE_LABELS[state.arterialModes[node.arterialId]])}</dd></div>
            <div class="flex justify-between gap-3"><dt>Cross street</dt><dd class="${v}">${escapeHtml(node.crossStreetName)}</dd></div>
            <div class="flex justify-between gap-3"><dt>Approaches</dt><dd class="${v}">${node.approaches.length}</dd></div>
            <div class="flex justify-between gap-3"><dt>To next signal</dt><dd class="${v}">${node.distanceToNextM ? `${node.distanceToNextM} m` : 'end of arterial'}</dd></div>
            <div class="flex justify-between gap-3"><dt>Node id</dt><dd class="font-mono text-slate-400 dark:text-slate-500">${escapeHtml(node.id)}</dd></div>
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
    try {
        await loadCorridor(el.corridorSelect.value);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(error);
        logChange('corridor', `FAILED to load ${el.corridorSelect.value}`);
    }
});

el.seedInput.addEventListener('change', () => {
    state.seed = Number(el.seedInput.value);
    logChange('seed', state.seed);
});

el.seedRandomise.addEventListener('click', () => {
    // Phase 1 only: picking a seed is not itself stochastic simulation input, and
    // build step 16 replaces every in-sim Math.random() call with the seeded PRNG.
    state.seed = Math.floor(Math.random() * 2 ** 31);
    el.seedInput.value = state.seed;
    logChange('seed', state.seed);
});

document.querySelectorAll('input[name="sensorMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
        if (!radio.checked) return;
        state.sensorMode = radio.value;
        el.sensorPillLabel.textContent = SENSOR_LABELS[radio.value];
        logChange('sensorMode', radio.value);
    });
});

document.getElementById('battery-backed-sensors').addEventListener('change', (event) => {
    state.batteryBackedSensors = event.target.checked;
    logChange('batteryBackedSensors', state.batteryBackedSensors);
});

document.getElementById('scheduled-outages').addEventListener('change', (event) => {
    state.power.scheduledOutages = event.target.checked;
    logChange('power.scheduledOutages', state.power.scheduledOutages);
});

document.getElementById('outage-off-minutes').addEventListener('change', (event) => {
    state.power.offMinutes = Number(event.target.value);
    logChange('power.offMinutes', state.power.offMinutes);
});

document.getElementById('outage-period-minutes').addEventListener('change', (event) => {
    state.power.periodMinutes = Number(event.target.value);
    logChange('power.periodMinutes', state.power.periodMinutes);
});

el.loadSheddingToggle.addEventListener('click', () => {
    state.power.loadShedding = !state.power.loadShedding;
    applyToggleFaces(el.loadSheddingToggle, state.power.loadShedding);
    renderPowerPill();
    logChange('power.loadShedding', state.power.loadShedding);
});

el.runToggle.addEventListener('click', () => {
    state.running = !state.running;
    applyToggleFaces(el.runToggle, state.running);
    renderRunPill();
    logChange('running', state.running);
});

el.stepButton.addEventListener('click', () => logChange('step', 'requested (no engine attached)'));

el.resetButton.addEventListener('click', () => {
    state.running = false;
    applyToggleFaces(el.runToggle, false);
    resetRunState();
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
    el.runStateLabel.textContent = state.running ? 'Running · Phase 1 stub' : 'Idle';
}

function renderPowerPill() {
    const tone = state.power.loadShedding ? 'rose' : 'emerald';
    el.powerPill.className = PILL_TONES[tone];
    el.powerPill.querySelector('span').className = DOT_TONES[tone];
    el.powerLabel.textContent = state.power.loadShedding ? 'Load shedding' : 'Power normal';
}

/** Clears every stat readout back to the em-dash placeholder. */
function resetRunState() {
    document.getElementById('sim-clock').textContent = '00:00.0';
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

let footerChart = null;

/**
 * The live divergence chart. Created empty in Phase 1: the axes, series and
 * legend exist so the layout is real, but there is nothing to plot until the
 * engine lands and starts pushing samples in build step 8.
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
        tickFormat: (v) => `${v}s`,
        xTitle: '',
    });
    options.layout.padding.top = 10;
    options.scales.y.suggestedMin = 0;
    options.scales.y.suggestedMax = 60;
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
            datasets: (layout?.arterials ?? []).map((arterial, index) =>
                lineDataset({ label: arterial.shortName, data: [], colour: accentFor(index) })
            ),
        },
        options,
    });

    return footerChart;
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
        el.corridorDescription.textContent = `Corridor failed to load: ${error.message}`;
    }

    renderPowerPill();
    renderRunPill();
})();
