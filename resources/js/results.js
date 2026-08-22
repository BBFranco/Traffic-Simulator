/**
 * /results page charts.
 *
 * The data comes from the `#results-data` payload, filled by ResultsController's
 * real Eloquent aggregates against `simulation_runs` (build step 19).
 *
 * Chart choices, and why:
 *   - Three grouped bar charts (magnitude comparison), x = power state,
 *     series = controller mode. Colour follows the mode, so a mode keeps its hue
 *     across all five charts on the page - and across both themes.
 *   - One line chart for recovery over time (change over time), with the outage
 *     window drawn as a shaded band rather than dashed rules.
 *   - One single-series horizontal bar for time-to-recovery: three values, no
 *     second dimension, so no legend - the title names the measure.
 *   - Every chart has a table twin in the page markup.
 *   - One y-axis per chart. Never two.
 *
 * Charts bake their ink in at construction, so a theme change rebuilds them all
 * rather than trying to patch colours in place.
 */

import {
    Chart,
    INK,
    MODE_COLOURS,
    MODE_LABELS,
    POWER_LABELS,
    applyChartTheme,
    baseOptions,
    barDataset,
    lineDataset,
    barValueLabels,
    lineEndLabels,
    xRangeBand,
} from './charts/theme.js';
import { onThemeChange } from './theme.js';
import { runHeadless } from './sim/runHeadless.js';
import { buildExperimentalMatrix, seedForRep } from './sim/experimentalMatrix.js';
import { toApiPayload } from './sim/apiPayload.js';

const data = JSON.parse(document.getElementById('results-data').textContent);

/** Fast lookup: "mode|power" -> aggregate row. Rebuilt after the batch-run button refreshes `data`. */
let byKey;

function rebuildByKey() {
    byKey = new Map(data.aggregates.map((row) => [`${row.controller_mode}|${row.power_state}`, row]));
    return byKey;
}

rebuildByKey();

const one = (v) => (v === null || v === undefined ? null : Number(Number(v).toFixed(1)));

/** Every live chart, so a theme change can tear them down cleanly. */
const charts = [];

/**
 * Value labels for a horizontal bar chart. The vertical-bar plugin measures bar
 * height, which is always ~0 when `indexAxis` is 'y', so this is its sibling.
 */
const hBarValueLabels = {
    id: 'hBarValueLabels',
    afterDatasetsDraw(chart, _args, opts) {
        const format = opts?.formatter ?? ((v) => `${v}`);
        const { ctx } = chart;
        ctx.save();
        ctx.font = '600 10px Figtree, ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = INK.secondary;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        chart.getDatasetMeta(0).data.forEach((bar, i) => {
            const value = chart.data.datasets[0].data[i];
            if (value === null || value === undefined) return;
            ctx.fillText(format(value), bar.x + 6, bar.y);
        });
        ctx.restore();
    },
};

/**
 * One dataset per controller mode, one bar group per power state.
 * @param {string} metric column name on the aggregate row
 */
function groupedByMode(metric) {
    return {
        labels: data.powerStates.map((p) => POWER_LABELS[p] ?? p),
        datasets: data.controllerModes.map((mode) =>
            barDataset({
                label: MODE_LABELS[mode] ?? mode,
                colour: MODE_COLOURS[mode],
                data: data.powerStates.map((power) => one(byKey.get(`${mode}|${power}`)?.[metric] ?? null)),
            })
        ),
    };
}

function groupedBarChart(canvasId, metric, { unit, tickSuffix = '' }) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const options = baseOptions({
        tickFormat: (v) => `${v}${tickSuffix}`,
        tooltipLabel: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}${unit}`,
    });

    charts.push(
        new Chart(canvas, {
            type: 'bar',
            data: groupedByMode(metric),
            options: {
                ...options,
                interaction: { mode: 'nearest', intersect: true },
                plugins: {
                    ...options.plugins,
                    barValueLabels: { formatter: (v) => `${v}` },
                },
            },
            plugins: [barValueLabels],
        })
    );
}

function recoveryChart() {
    const canvas = document.getElementById('chart-recovery');
    if (!canvas) return;

    const timeline = data.recoveryTimeline;
    if (!timeline?.seconds?.length) return; // no CSV output yet - see ResultsController::csvRecoveryTimeline()

    const options = baseOptions({
        xTitle: 'seconds into run',
        tickFormat: (v) => `${v}s`,
        tooltipLabel: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} s`,
    });
    // Room on the right for the end-of-line series labels.
    options.layout.padding.right = 92;

    charts.push(
        new Chart(canvas, {
            type: 'line',
            data: {
                labels: timeline.seconds,
                datasets: data.controllerModes
                    .filter((mode) => timeline.series[mode])
                    .map((mode) =>
                        lineDataset({
                            label: MODE_LABELS[mode] ?? mode,
                            colour: MODE_COLOURS[mode],
                            data: timeline.series[mode],
                        })
                    ),
            },
            options: {
                ...options,
                plugins: {
                    ...options.plugins,
                    // Category scale: the band is addressed by label index, not by seconds.
                    // Null when no run's summary carried a power-event tick (a normal-power
                    // representative run) - omit the plugin config entirely rather than pass -1 indices.
                    ...(timeline.sheddingStart != null && timeline.sheddingEnd != null
                        ? {
                              xRangeBand: {
                                  from: timeline.seconds.indexOf(timeline.sheddingStart),
                                  to: timeline.seconds.indexOf(timeline.sheddingEnd),
                                  label: 'LIGHTS DARK',
                              },
                          }
                        : {}),
                },
            },
            plugins: [xRangeBand, lineEndLabels],
        })
    );
}

function recoveryTimeChart() {
    const canvas = document.getElementById('chart-recovery-time');
    if (!canvas) return;

    const modes = data.controllerModes.filter(
        (mode) => byKey.get(`${mode}|load_shedding`)?.time_to_recovery_seconds != null
    );

    const options = baseOptions({ tooltipLabel: (ctx) => `${ctx.parsed.x} s to recover` });
    options.layout.padding = { top: 6, right: 40, bottom: 2, left: 2 };
    // Horizontal bars: the value scale is x, so the grid moves with it.
    options.scales = {
        x: {
            beginAtZero: true,
            grid: { color: INK.grid, drawTicks: false },
            border: { display: false },
            ticks: { color: INK.secondary, padding: 6, callback: (v) => `${v}s` },
        },
        y: {
            grid: { display: false },
            border: { color: INK.axis },
            ticks: { color: INK.primary },
        },
    };

    charts.push(
        new Chart(canvas, {
            type: 'bar',
            data: {
                labels: modes.map((mode) => MODE_LABELS[mode] ?? mode),
                datasets: [
                    {
                        label: 'Time to recovery',
                        data: modes.map((mode) =>
                            one(byKey.get(`${mode}|load_shedding`).time_to_recovery_seconds)
                        ),
                        // Colour still follows the entity: each bar takes its mode's hue.
                        backgroundColor: modes.map((mode) => MODE_COLOURS[mode]),
                        borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 4, bottomRight: 4 },
                        borderSkipped: 'left',
                        categoryPercentage: 0.62,
                        barPercentage: 0.86,
                        maxBarThickness: 34,
                    },
                ],
            },
            options: {
                ...options,
                indexAxis: 'y',
                interaction: { mode: 'nearest', intersect: true },
                plugins: {
                    ...options.plugins,
                    hBarValueLabels: { formatter: (v) => `${v}s` },
                },
            },
            plugins: [hBarValueLabels],
        })
    );
}

function renderAll() {
    while (charts.length) charts.pop().destroy();

    groupedBarChart('chart-wait', 'avg_wait_time', { unit: ' s', tickSuffix: 's' });
    groupedBarChart('chart-throughput', 'throughput_per_min', { unit: ' veh/min' });
    groupedBarChart('chart-cleared', 'pct_cleared_without_stop', { unit: '%', tickSuffix: '%' });
    recoveryChart();
    recoveryTimeChart();
}

onThemeChange((theme) => {
    applyChartTheme(theme);
    renderAll();
});

/* ------------------------------------------------------- batch-run button */

/**
 * Build steps 17-18: runs the full 12-condition x 30-rep experimental matrix
 * (360 headless runs) in this tab and populates `simulation_runs`.
 *
 * `runHeadless()` here is the exact same function batch/runBatch.mjs calls
 * from the CLI - only the driver differs (a browser button instead of a
 * terminal), per the Phase 2 spec.
 */
const REPS_PER_CONDITION = 30;
const DURATION_TICKS = 3600; // 6 simulated minutes per run at DT=0.1s
const POWER_EVENT_TICK = 1800; // load-shedding conditions trigger halfway through
const DT = 0.1;
const BASE_SEED = 20260101;
/** Batch the network writes - don't POST 360 times (build step 17). */
const POST_BATCH_SIZE = 25;

const batchButton = document.getElementById('batch-run-button');
const batchProgressWrap = document.getElementById('batch-progress-wrap');
const batchProgressBar = document.getElementById('batch-progress-bar');
const batchProgressLabel = document.getElementById('batch-progress-label');
const batchProgressPct = document.getElementById('batch-progress-pct');
const batchRunningBadge = document.getElementById('batch-running-badge');

let batchRunning = false;

batchButton?.addEventListener('click', async () => {
    if (batchRunning) return;
    batchRunning = true;
    batchButton.disabled = true;
    batchRunningBadge?.classList.remove('hidden');
    document.getElementById('fake-data-badge')?.classList.add('hidden');
    document.getElementById('fake-data-banner')?.classList.add('hidden');
    if (batchProgressLabel) batchProgressLabel.textContent = 'Starting...';
    if (batchProgressBar) batchProgressBar.style.width = '0%';
    if (batchProgressPct) batchProgressPct.textContent = '0%';
    batchProgressWrap?.classList.remove('hidden');

    try {
        const corridorId = document.getElementById('filter-corridor')?.value || data.defaultCorridorId;
        const corridorConfig = await fetchCorridor(corridorId);
        const matrix = buildExperimentalMatrix();
        const totalRuns = matrix.length * REPS_PER_CONDITION;

        let completed = 0;
        let pending = [];

        for (const condition of matrix) {
            for (let rep = 0; rep < REPS_PER_CONDITION; rep += 1) {
                const seed = seedForRep(BASE_SEED, condition.powerState, rep);
                const { summary } = runHeadless({
                    seed,
                    controllerMode: condition.controllerMode,
                    sensorMode: condition.sensorMode,
                    powerEvent: condition.powerState === 'load_shedding' ? POWER_EVENT_TICK : null,
                    corridorConfig,
                    durationTicks: DURATION_TICKS,
                    dt: DT,
                });

                pending.push(toApiPayload(summary));
                completed += 1;
                updateBatchProgress(completed, totalRuns, condition.key);

                if (pending.length >= POST_BATCH_SIZE) {
                    await postSimulationRuns(pending.splice(0, pending.length));
                }

                // Yield control back to the browser so the progress bar actually
                // repaints - a tight synchronous loop never gets the chance.
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }

        if (pending.length) await postSimulationRuns(pending);

        await refreshAggregatesAndRerender();
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Batch run failed', error);
        // Nothing got saved (or refreshAggregatesAndRerender never ran to hide
        // it), so the "no data yet" state is still accurate - restore it.
        if (!data.aggregates?.length) {
            document.getElementById('fake-data-badge')?.classList.remove('hidden');
            document.getElementById('fake-data-banner')?.classList.remove('hidden');
        }
        // A dev/dissertation tool, not consumer UI - a blocking alert is an
        // acceptable, unmissable failure signal here.
        // eslint-disable-next-line no-alert
        alert(`Batch run failed: ${error.message}`);
    } finally {
        batchRunning = false;
        batchButton.disabled = false;
        batchButton.textContent = 'Generate dataset (360 runs)';
        batchRunningBadge?.classList.add('hidden');
        batchProgressWrap?.classList.add('hidden');
    }
});

function updateBatchProgress(completed, total, conditionKey) {
    const pct = Math.round((completed / total) * 100);
    if (batchProgressBar) batchProgressBar.style.width = `${pct}%`;
    if (batchProgressPct) batchProgressPct.textContent = `${pct}% · ${completed}/${total} runs`;
    if (batchProgressLabel) batchProgressLabel.textContent = `${conditionKey} · rep ${((completed - 1) % REPS_PER_CONDITION) + 1}/${REPS_PER_CONDITION}`;
    if (batchButton) batchButton.textContent = `Running... ${completed}/${total}`;
}

async function fetchCorridor(id) {
    const url = data.corridorUrlTemplate.replace('__ID__', encodeURIComponent(id));
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Failed to load corridor "${id}" (HTTP ${response.status}).`);
    return response.json();
}

async function postSimulationRuns(payloads) {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
    const response = await fetch('/api/simulation-runs', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-CSRF-TOKEN': csrfToken ?? '',
        },
        body: JSON.stringify({ runs: payloads }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`POST /api/simulation-runs -> ${response.status}: ${body.slice(0, 300)}`);
    }
}

/** Re-fetch the aggregate queries and redraw the charts - no full page reload (build step 17). */
async function refreshAggregatesAndRerender(params = currentFilterParams()) {
    const url = params.toString() ? `${data.resultsDataUrl}?${params}` : data.resultsDataUrl;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return;

    const fresh = await response.json();
    Object.assign(data, fresh);
    rebuildByKey();
    renderAll();
    document.getElementById('fake-data-badge')?.classList.add('hidden');
    document.getElementById('fake-data-banner')?.classList.add('hidden');
}

function currentFilterParams() {
    const params = new URLSearchParams();
    const corridor = document.getElementById('filter-corridor')?.value;
    const sensor = document.getElementById('filter-sensor')?.value;
    if (corridor) params.set('corridor', corridor);
    if (sensor && sensor !== 'all') params.set('sensor', sensor);
    return params;
}

for (const id of ['filter-corridor', 'filter-sensor']) {
    document.getElementById(id)?.addEventListener('change', () => {
        const params = currentFilterParams();
        const query = params.toString();
        history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
        refreshAggregatesAndRerender(params);
    });
}
