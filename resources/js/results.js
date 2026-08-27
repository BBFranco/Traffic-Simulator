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
 *   - Two single-series horizontal bars for time-to-recovery (wait, then throughput): three
 *     values each, no second dimension, so no legend - the title names the measure.
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
import { accumulateRecoveryTicks, finalizeRecoveryTickPayload } from './sim/recoveryTickPayload.js';

const data = JSON.parse(document.getElementById('results-data').textContent);

/** Fast lookup: "mode|power" -> aggregate row. Rebuilt after the batch-run button refreshes `data`. */
let byKey;

/** Fast lookup: "sensor|power" -> aggregate row, adaptive's rows only (the only mode that varies by sensor). */
let byKeyBySensor;

function rebuildByKey() {
    byKey = new Map(data.aggregates.map((row) => [`${row.controller_mode}|${row.power_state}`, row]));
    byKeyBySensor = new Map(
        data.aggregatesBySensor
            .filter((row) => row.controller_mode === 'adaptive' && row.sensor_mode)
            .map((row) => [`${row.sensor_mode}|${row.power_state}`, row])
    );
    return byKey;
}

rebuildByKey();

/** The "Compare against fixed-time" dropdown's raw selection, as {mode, sensor}. */
function selectedItsTarget() {
    const [mode, sensor] = (document.getElementById('filter-its-target')?.value || '').split('|');
    return { mode, sensor };
}

/**
 * Which adaptive sensor mode the dropdown has selected, or null for the blended average / a
 * non-adaptive target - in which case the charts keep reading the blended `data.aggregates` row.
 */
function selectedAdaptiveSensor() {
    const { mode, sensor } = selectedItsTarget();
    return mode === 'adaptive' && sensor && sensor !== 'average' ? sensor : null;
}

/** The aggregate row backing a mode's bar at a given power state - adaptive's row follows the dropdown's sensor pick. */
function rowForModeAndPower(mode, power) {
    const sensor = selectedAdaptiveSensor();
    return mode === 'adaptive' && sensor ? byKeyBySensor.get(`${sensor}|${power}`) : byKey.get(`${mode}|${power}`);
}

/** The "Scope" dropdown's raw selection - 'total' | 'arterial' | 'side_street'. */
function selectedScope() {
    return document.getElementById('filter-scope')?.value || 'total';
}

/**
 * Every scoped metric column follows `<metric>` (Total) / `<metric>_arterial` / `<metric>_side_street`
 * (see ResultsController's SCOPES) - this resolves whichever one the Scope dropdown has selected.
 */
function scopedMetric(metric) {
    const scope = selectedScope();
    return scope === 'total' ? metric : `${metric}_${scope}`;
}

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
                data: data.powerStates.map((power) => one(rowForModeAndPower(mode, power)?.[scopedMetric(metric)] ?? null)),
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

/**
 * The line chart's Adaptive series for `metric` ('throughput_per_min' or 'avg_wait_time'):
 * the selected sensor's own recorded curve, or - for the blended "average of sensors" target -
 * a point-wise average across whichever adaptive sensor curves were actually captured (there's
 * no literal run backing a blended curve, unlike the scalar aggregates() average, so it's
 * computed here instead of stored).
 */
function adaptiveRecoverySeries(timeline, metric) {
    const key = scopedMetric(metric);
    const target = selectedItsTarget();
    if (target.mode === 'adaptive' && target.sensor && target.sensor !== 'average') {
        return timeline.series[`adaptive|${target.sensor}`]?.[key] ?? null;
    }

    const sensorSeries = Object.keys(timeline.series)
        .filter((seriesKey) => seriesKey.startsWith('adaptive|'))
        .map((seriesKey) => timeline.series[seriesKey][key]);
    if (!sensorSeries.length) return null;

    return sensorSeries[0].map((_, i) => one(sensorSeries.reduce((sum, s) => sum + s[i], 0) / sensorSeries.length));
}

/** Index of the sample closest to `target` - recovery ticks are sampled every few
 * seconds, so an outage timestamp rarely lands on an exact sample. */
function nearestSecondIndex(seconds, target) {
    let bestIndex = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < seconds.length; i += 1) {
        const diff = Math.abs(seconds[i] - target);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIndex = i;
        }
    }
    return bestIndex;
}

function buildRecoveryLineChart(canvasId, metric, { tooltipUnit }) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const timeline = data.recoveryTimeline;
    if (!timeline?.seconds?.length) return; // no representative run captured yet - see ResultsController::dbRecoveryTimeline()

    const scopedKey = scopedMetric(metric);
    const seriesByMode = {
        fixed: timeline.series['fixed|']?.[scopedKey],
        green_wave: timeline.series['green_wave|']?.[scopedKey],
        adaptive: adaptiveRecoverySeries(timeline, metric),
    };

    const options = baseOptions({
        xTitle: 'seconds into run',
        tickFormat: (v) => `${v}`,
        tooltipLabel: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} ${tooltipUnit}`,
    });
    // Room on the right for the end-of-line series labels.
    options.layout.padding.right = 92;

    charts.push(
        new Chart(canvas, {
            type: 'line',
            data: {
                labels: timeline.seconds,
                datasets: data.controllerModes
                    .filter((mode) => seriesByMode[mode])
                    .map((mode) =>
                        lineDataset({
                            label: MODE_LABELS[mode] ?? mode,
                            colour: MODE_COLOURS[mode],
                            data: seriesByMode[mode],
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
                                  from: nearestSecondIndex(timeline.seconds, timeline.sheddingStart),
                                  to: nearestSecondIndex(timeline.seconds, timeline.sheddingEnd),
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

function recoveryChart() {
    buildRecoveryLineChart('chart-recovery', 'throughput_per_min', { tooltipUnit: 'veh/min' });
}

function recoveryWaitChart() {
    buildRecoveryLineChart('chart-recovery-wait', 'avg_wait_time', { tooltipUnit: 's' });
}

/**
 * One single-series horizontal bar for time-to-recovery, parameterised by metric column so
 * both the wait-based and throughput-based cards (see runHeadless.js's computeRecoverySeconds)
 * render off the same code - three values, no second dimension, so no legend.
 */
function recoveryTimeChart(canvasId, metricColumn, { barLabel }) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const recoveryKey = scopedMetric(metricColumn);
    const modes = data.controllerModes.filter((mode) => rowForModeAndPower(mode, 'load_shedding')?.[recoveryKey] != null);

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
                        label: barLabel,
                        data: modes.map((mode) => one(rowForModeAndPower(mode, 'load_shedding')[recoveryKey])),
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
    // Wait before throughput throughout this page - keep new recovery charts in that order too.
    recoveryWaitChart();
    recoveryChart();
    recoveryTimeChart('chart-recovery-time-wait', 'time_to_recovery_wait_seconds', { barLabel: 'Time to recovery (wait)' });
    recoveryTimeChart('chart-recovery-time', 'time_to_recovery_seconds', { barLabel: 'Time to recovery (throughput)' });
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
const DURATION_TICKS = 24000; // 40 measured simulated minutes per run at DT=0.1s
// Warm-up run BEFORE anything is measured, discarded from every stat - standard
// traffic-sim practice, long enough for this corridor's own from-empty ramp-up
// transient to finish under normal power before the outage/recovery windows below
// land inside an already-equilibrated corridor. See engine.js's resetStats().
const WARMUP_TICKS = 3600; // 6 simulated minutes
// Load-shedding conditions cut power a quarter of the way into the MEASURED window
// and restore it at the halfway mark - see batch/runBatch.mjs's matching default schedule.
const POWER_OUTAGE_START_TICK = Math.round(DURATION_TICKS * 0.25);
const POWER_OUTAGE_END_TICK = Math.round(DURATION_TICKS * 0.5);
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
            let recoveryAcc = null;

            for (let rep = 0; rep < REPS_PER_CONDITION; rep += 1) {
                const seed = seedForRep(BASE_SEED, condition.powerState, rep);
                const { rows, sideStreetRows, summary } = runHeadless({
                    seed,
                    controllerMode: condition.controllerMode,
                    sensorMode: condition.sensorMode,
                    warmupTicks: WARMUP_TICKS,
                    powerOutageStartTick: condition.powerState === 'load_shedding' ? POWER_OUTAGE_START_TICK : null,
                    powerOutageEndTick: condition.powerState === 'load_shedding' ? POWER_OUTAGE_END_TICK : null,
                    corridorConfig,
                    durationTicks: DURATION_TICKS,
                    dt: DT,
                });

                pending.push(toApiPayload(summary));
                completed += 1;
                updateBatchProgress(completed, totalRuns, condition.key);

                // Every rep of a load-shedding condition folds into this condition's recovery
                // curve, so the chart averages the same population the "time to recovery" stat
                // card does - posted once after the last rep, not batched with the summary POSTs.
                if (condition.powerState === 'load_shedding') {
                    recoveryAcc = accumulateRecoveryTicks(recoveryAcc, { rows, sideStreetRows });
                }

                if (pending.length >= POST_BATCH_SIZE) {
                    await postSimulationRuns(pending.splice(0, pending.length));
                }

                // Yield control back to the browser so the progress bar actually
                // repaints - a tight synchronous loop never gets the chance.
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => setTimeout(resolve, 0));
            }

            if (recoveryAcc) {
                await postRecoveryTicks(
                    finalizeRecoveryTickPayload(recoveryAcc, {
                        controllerMode: condition.controllerMode,
                        sensorMode: condition.sensorMode,
                        dt: DT,
                        powerOutageStartTick: POWER_OUTAGE_START_TICK,
                        powerOutageEndTick: POWER_OUTAGE_END_TICK,
                    })
                );
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

async function postRecoveryTicks(payload) {
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
    const response = await fetch('/api/recovery-ticks', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-CSRF-TOKEN': csrfToken ?? '',
        },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`POST /api/recovery-ticks -> ${response.status}: ${body.slice(0, 300)}`);
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

/* ------------------------------------------------------- ITS-target filter */

/**
 * Which single ITS configuration - a specific adaptive sensor mode, the
 * blended adaptive average, or green-wave - the "vs fixed-time" stat blocks
 * and the per-condition chart trio compare adaptive against. Every
 * configuration is already in the initial payload, so switching it is a
 * local toggle/rerender, not a fetch.
 */
function applyItsTargetFilter() {
    const select = document.getElementById('filter-its-target');
    if (!select) return;
    const key = select.value;
    const scope = selectedScope();
    document.querySelectorAll('[data-its-key]').forEach((card) => {
        card.classList.toggle('hidden', card.dataset.itsKey !== key || card.dataset.scope !== scope);
    });

    highlightMatchingRecentRuns();
}

/**
 * The Recent Runs table isn't filtered by the "Compare against fixed-time" dropdown (it's
 * always the most-recent 10 rows overall, so it can auditably show a different sensor mode
 * than whatever aggregate is on screen) - this highlights the rows that DO match the current
 * selection instead, so a viewer can still spot-check the headline number against a real run.
 */
function highlightMatchingRecentRuns() {
    const { mode, sensor } = selectedItsTarget();
    document.querySelectorAll('[data-run-controller-mode]').forEach((row) => {
        const sensorMatches = mode !== 'adaptive' || sensor === 'average' || row.dataset.runSensorMode === sensor;
        const matches = row.dataset.runControllerMode === mode && sensorMatches;
        row.classList.toggle('bg-sky-50', matches);
        row.classList.toggle('dark:bg-sky-500/10', matches);
        row.classList.toggle('opacity-50', !matches);
    });
}

/**
 * The per-condition-means and segmented data tables render all three scopes'
 * rows up front (server-side, see results.blade.php) and just toggle which
 * one is visible - same mechanism as applyItsTargetFilter()'s card toggling,
 * but scanned only within these two tables so it doesn't fight that
 * function's own data-scope handling on the comparison cards.
 */
function applyTableScopeFilter() {
    const scope = selectedScope();
    document.querySelectorAll('#per-condition-table [data-scope], #segmented-table [data-scope]').forEach((row) => {
        row.classList.toggle('hidden', row.dataset.scope !== scope);
    });
}

document.getElementById('filter-its-target')?.addEventListener('change', () => {
    applyItsTargetFilter();
    renderAll();
});
document.getElementById('filter-scope')?.addEventListener('change', () => {
    applyItsTargetFilter();
    applyTableScopeFilter();
    renderAll();
});
applyItsTargetFilter();
applyTableScopeFilter();
