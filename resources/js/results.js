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
import { Fireworks } from 'fireworks-js';
import { onThemeChange } from './theme.js';
import { buildExperimentalMatrix, seedForRep } from './sim/experimentalMatrix.js';
import { toApiPayload } from './sim/apiPayload.js';
import { accumulateRecoveryTicks, finalizeRecoveryTickPayload } from './sim/recoveryTickPayload.js';
import batchWorkerUrl from './sim/batchWorker.js?worker&url';

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
                // The mean only covers runs that recovered - show how many that is.
                labels: modes.map((mode) => {
                    const row = rowForModeAndPower(mode, 'load_shedding');
                    return [MODE_LABELS[mode] ?? mode, `${row[`${recoveryKey}_recovered`]}/${row.runs} recovered`];
                }),
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
 * terminal), per the Phase 2 spec. It runs in a Web Worker
 * (sim/batchWorker.js) so the page stays responsive while it works.
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

batchButton?.addEventListener('click', () => openBatchModal());

/**
 * Runs the 360-run batch (unchanged from before the modal existed - only the
 * corridorConfig passed in can now carry per-street demand overrides from the
 * modal, see runBatchModal.js's docblock at the top of this section).
 *
 * @param {Record<string, {min: number, max: number, saturationFlowPerLanePerHour: number}>} demandOverrides
 *   Keyed by street id (arterial or connector), spec §10-11.
 */
async function runBatch(demandOverrides) {
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

    let worker = null;

    try {
        worker = createBatchWorker();
        const corridorId = document.getElementById('filter-corridor')?.value || data.defaultCorridorId;
        const corridorConfig = applyDemandOverrides(await fetchCorridor(corridorId), demandOverrides);
        const matrix = buildExperimentalMatrix();
        const batchId = newBatchId();
        const totalRuns = matrix.length * REPS_PER_CONDITION;

        let completed = 0;
        let pending = [];

        for (const condition of matrix) {
            let recoveryAcc = null;

            for (let rep = 0; rep < REPS_PER_CONDITION; rep += 1) {
                const seed = seedForRep(BASE_SEED, condition.powerState, rep);
                // A run takes seconds - say which one is under way, not just the last one finished.
                if (batchProgressLabel) batchProgressLabel.textContent = `${condition.key} · rep ${rep + 1}/${REPS_PER_CONDITION} · running...`;
                // eslint-disable-next-line no-await-in-loop
                const { rows, sideStreetRows, summary } = await runHeadlessInWorker(worker, {
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

                pending.push(toApiPayload(summary, batchId));
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
            }

            if (recoveryAcc) {
                await postRecoveryTicks(
                    finalizeRecoveryTickPayload(recoveryAcc, {
                        controllerMode: condition.controllerMode,
                        sensorMode: condition.sensorMode,
                        corridorId: corridorConfig.id,
                        dt: DT,
                        powerOutageStartTick: POWER_OUTAGE_START_TICK,
                        powerOutageEndTick: POWER_OUTAGE_END_TICK,
                    })
                );
            }
        }

        if (batchProgressLabel) batchProgressLabel.textContent = 'Saving results...';
        if (pending.length) await postSimulationRuns(pending);

        if (batchProgressLabel) batchProgressLabel.textContent = 'Refreshing charts...';
        await refreshAggregatesAndRerender();
        celebrateBatchComplete(totalRuns);
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
        worker?.terminate();
        batchRunning = false;
        batchButton.disabled = false;
        batchButton.textContent = 'Generate dataset (360 runs)';
        batchRunningBadge?.classList.add('hidden');
        batchProgressWrap?.classList.add('hidden');
    }
}

/**
 * One id shared by every run of this batch - /results only shows each corridor's latest batch.
 * `crypto.randomUUID()` is secure-context only (a plain-http Herd .test site isn't), so this
 * builds the v4 UUID from getRandomValues, which works everywhere.
 */
function newBatchId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The batch worker. Under `npm run dev` its script comes from the Vite dev
 * server, a different origin from the page (Herd's .test domain), and the
 * browser refuses a cross-origin Worker outright - so there it's started from
 * a same-origin blob that just imports the real module (the dev server allows
 * the app's origin via CORS). A built bundle is same-origin and loads directly.
 */
function createBatchWorker() {
    const url = new URL(batchWorkerUrl, import.meta.url); // a bare path means the dev server in dev, the page's origin once built
    if (url.origin === window.location.origin) return new Worker(url, { type: 'module' });
    const shim = new Blob([`import ${JSON.stringify(url.href)};`], { type: 'text/javascript' });
    return new Worker(URL.createObjectURL(shim), { type: 'module' });
}

/** One runHeadless() call on the batch worker - runs go one at a time, so matching on `id` is only a guard. */
let workerRequestId = 0;
function runHeadlessInWorker(worker, options) {
    const id = ++workerRequestId;
    return new Promise((resolve, reject) => {
        const cleanUp = () => {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
        };
        const onMessage = ({ data: reply }) => {
            if (reply.id !== id) return;
            cleanUp();
            if (reply.error) reject(new Error(reply.error));
            else resolve(reply.result);
        };
        const onError = (event) => {
            cleanUp();
            reject(new Error(event.message || 'Batch worker failed'));
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.postMessage({ id, options });
    });
}

/** Success toast + a brief fireworks burst when the 360-run batch finishes. */
function celebrateBatchComplete(totalRuns) {
    const toast = document.getElementById('batch-complete-toast');
    const toastLabel = document.getElementById('batch-complete-toast-label');
    if (toastLabel) toastLabel.textContent = `Dataset generated — ${totalRuns} runs complete.`;
    toast?.classList.remove('hidden');

    const fireworksContainer = document.getElementById('fireworks-container');
    if (fireworksContainer) {
        fireworksContainer.classList.remove('hidden');
        const fireworks = new Fireworks(fireworksContainer, {
            autoresize: true,
            opacity: 0.5,
            acceleration: 1.05,
            friction: 0.97,
            gravity: 1.5,
            particles: 90,
            explosion: 5,
            intensity: 30,
            traceLength: 3,
            traceSpeed: 10,
            rocketsPoint: { min: 0, max: 100 },
            lineWidth: { explosion: { min: 1, max: 3 }, trace: { min: 1, max: 2 } },
            lineStyle: 'round',
            hue: { min: 0, max: 360 },
            delay: { min: 15, max: 30 },
            sound: { enabled: false },
        });
        fireworks.start();
        setTimeout(() => {
            fireworks.stop();
            fireworksContainer.classList.add('hidden');
        }, 4000);
    }

    setTimeout(() => toast?.classList.add('hidden'), 6000);
}

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

/* ============================================================ batch modal (spec §10-11) */

/** Every arterial + connector in a corridor config, in the same shape a demand row needs. */
function streetsOf(corridorConfig) {
    const arterials = (corridorConfig.arterials ?? []).map((a) => ({
        id: a.id, name: a.shortName ?? a.name, demand: a.demand, type: 'arterial',
    }));
    const connectors = (corridorConfig.connectors ?? []).map((c) => ({
        id: c.id, name: c.name, demand: c.demand, type: 'cross-street',
    }));
    return [...arterials, ...connectors];
}

/** Badge styling per street type - the only thing that visually told the batch modal's
 * cards apart before this was their (identical) border colour. */
const STREET_TYPE_BADGES = {
    arterial: {
        label: 'Arterial',
        classes: 'border border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-300',
    },
    'cross-street': {
        label: 'Cross-street',
        classes: 'border border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300',
    },
};

const batchModalBackdrop = document.getElementById('batch-modal-backdrop');
const batchModalStreets = document.getElementById('batch-modal-streets');

async function openBatchModal() {
    if (batchRunning) return;
    batchModalBackdrop?.classList.remove('hidden');
    batchModalStreets.innerHTML = '<p class="text-xs text-slate-400">Loading corridor…</p>';

    try {
        const corridorId = document.getElementById('filter-corridor')?.value || data.defaultCorridorId;
        const corridorConfig = await fetchCorridor(corridorId);
        renderBatchModalStreets(corridorConfig, corridorId);
    } catch (error) {
        batchModalStreets.innerHTML = `<p class="text-xs text-red-600 dark:text-red-400">${error.message}</p>`;
    }
}

function closeBatchModal() {
    batchModalBackdrop?.classList.add('hidden');
}

function renderBatchModalStreets(corridorConfig, corridorId) {
    const streets = streetsOf(corridorConfig);

    batchModalStreets.innerHTML = streets
        .map((street, index) => {
            const importOptions = data.trafficCounts
                .filter((c) => c.corridor_config === corridorId && c.street === street.id)
                .map((c) => `<option value="${c.id}">${c.label}</option>`)
                .join('');
            const badge = STREET_TYPE_BADGES[street.type];
            // Zebra striping so adjacent cards stay visually separate even when their
            // borders alone don't read clearly (e.g. stacked full-width on narrow screens).
            const stripeClass = index % 2 === 1 ? 'bg-slate-50 dark:bg-slate-800/40' : 'bg-white dark:bg-slate-900';

            return `
                <div class="rounded-md border border-slate-200 p-3 dark:border-slate-700 ${stripeClass}" data-street-row data-street-id="${street.id}">
                    <div class="mb-2 flex items-center gap-2">
                        <span class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badge.classes}">${badge.label}</span>
                        <span class="min-w-0 flex-1 truncate text-xs font-semibold text-slate-900 dark:text-slate-100">${street.name}</span>
                    </div>
                    <div class="grid grid-cols-3 gap-2">
                        <label class="text-[10px] text-slate-500">Min (veh/lane/min)
                            <input type="number" step="0.1" data-field="min" value="${street.demand.spawnRatePerLanePerMinMin}"
                                   class="mt-0.5 w-full rounded-md border-slate-300 bg-white py-1 text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100" />
                        </label>
                        <label class="text-[10px] text-slate-500">Max (veh/lane/min)
                            <input type="number" step="0.1" data-field="max" value="${street.demand.spawnRatePerLanePerMinMax}"
                                   class="mt-0.5 w-full rounded-md border-slate-300 bg-white py-1 text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100" />
                        </label>
                        <label class="text-[10px] text-slate-500">Saturation flow (veh/lane/hr)
                            <input type="number" step="1" data-field="saturation" value="${street.demand.saturationFlowPerLanePerHour}"
                                   class="mt-0.5 w-full rounded-md border-slate-300 bg-white py-1 text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100" />
                        </label>
                    </div>
                    <div class="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 dark:border-slate-800">
                        <p class="text-[10px] text-slate-400">${street.demand.fluctuationPeriodS}s sinusoid period (fixed, not calibrated)</p>
                        ${importOptions ? `
                        <select data-field="import" class="rounded-md border-slate-300 bg-white py-1 text-[11px] text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
                            <option value="">Import from Traffic Counter…</option>
                            ${importOptions}
                        </select>` : ''}
                    </div>
                </div>`;
        })
        .join('');
}

// Selecting an import fills that street's min/max from the fitted mid/amplitude
// (spec §10) - fields stay editable afterwards, same as the manual defaults.
batchModalStreets?.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-field="import"]');
    if (!select) return;
    const row = select.closest('[data-street-row]');
    const count = data.trafficCounts.find((c) => String(c.id) === select.value);
    if (!count) return;

    row.querySelector('input[data-field="min"]').value = (count.fitted_mid - count.fitted_amplitude).toFixed(2);
    row.querySelector('input[data-field="max"]').value = (count.fitted_mid + count.fitted_amplitude).toFixed(2);
});

document.getElementById('batch-modal-close')?.addEventListener('click', closeBatchModal);
document.getElementById('batch-modal-cancel')?.addEventListener('click', closeBatchModal);
batchModalBackdrop?.addEventListener('click', (event) => {
    if (event.target === batchModalBackdrop) closeBatchModal();
});

document.getElementById('batch-modal-confirm')?.addEventListener('click', () => {
    const overrides = {};
    batchModalStreets.querySelectorAll('[data-street-row]').forEach((row) => {
        overrides[row.dataset.streetId] = {
            min: Number(row.querySelector('input[data-field="min"]').value),
            max: Number(row.querySelector('input[data-field="max"]').value),
            saturationFlowPerLanePerHour: Number(row.querySelector('input[data-field="saturation"]').value),
        };
    });
    closeBatchModal();
    runBatch(overrides);
});

/** Clones corridorConfig and overwrites each street's demand with the modal's values. */
function applyDemandOverrides(corridorConfig, overrides) {
    const clone = structuredClone(corridorConfig);
    for (const street of [...(clone.arterials ?? []), ...(clone.connectors ?? [])]) {
        const override = overrides[street.id];
        if (!override) continue;
        street.demand = {
            ...street.demand,
            spawnRatePerLanePerMinMin: override.min,
            spawnRatePerLanePerMinMax: override.max,
            saturationFlowPerLanePerHour: override.saturationFlowPerLanePerHour,
        };
    }
    return clone;
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

/**
 * Re-fetch the aggregate queries and redraw the charts - no full page reload (build step 17).
 *
 * Corridor used to only refresh the bar-chart trio + recovery charts here, leaving
 * the "vs fixed-time" cards, the per-condition/segmented table rows, and Recent Runs frozen at
 * whatever the initial page load showed - the dropdown looked like a no-op even though the
 * server-side query was genuinely filtered. `fresh.html` now carries the same Blade partials
 * the initial page renders (see ResultsController::data()'s docblock), computed from the same
 * filtered query - swap them in, then re-apply the client-side togglers (Compare-against-
 * fixed-time, Scope) since the freshly-injected DOM starts without any `.hidden` state.
 */
async function refreshAggregatesAndRerender(params = currentFilterParams()) {
    const url = params.toString() ? `${data.resultsDataUrl}?${params}` : data.resultsDataUrl;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return;

    const fresh = await response.json();
    Object.assign(data, fresh);
    rebuildByKey();

    if (fresh.html) {
        const setHtml = (id, html) => {
            const el = document.getElementById(id);
            if (el && html !== undefined) el.innerHTML = html;
        };
        setHtml('research-question-cards', fresh.html.researchQuestionCards);
        setHtml('metric-section-groups', fresh.html.metricSectionGroups);

        const perConditionBody = document.querySelector('#per-condition-table tbody');
        if (perConditionBody) perConditionBody.innerHTML = fresh.html.perConditionRows;

        const segmentedBody = document.querySelector('#segmented-table tbody');
        if (segmentedBody) segmentedBody.innerHTML = fresh.html.segmentedRows;

        const recentRunsBody = document.querySelector('#recent-runs-table tbody');
        if (recentRunsBody) recentRunsBody.innerHTML = fresh.html.recentRunsRows;

        // Preserve the current "Compare against fixed-time" selection across the option-list
        // refresh where possible - a filtered corridor can occasionally not have every
        // comparison target the unfiltered view did.
        const itsSelect = document.getElementById('filter-its-target');
        if (itsSelect) {
            const prevValue = itsSelect.value;
            itsSelect.innerHTML = fresh.html.itsTargetOptions;
            if ([...itsSelect.options].some((option) => option.value === prevValue)) {
                itsSelect.value = prevValue;
            }
        }
    }

    renderAll();
    applyItsTargetFilter();
    applyTableScopeFilter();
    if (exportPdfButton) exportPdfButton.disabled = !data.aggregates?.length;
    document.getElementById('fake-data-badge')?.classList.add('hidden');
    document.getElementById('fake-data-banner')?.classList.add('hidden');
}

function currentFilterParams() {
    const params = new URLSearchParams();
    const corridor = document.getElementById('filter-corridor')?.value;
    if (corridor) params.set('corridor', corridor);
    return params;
}

document.getElementById('filter-corridor')?.addEventListener('change', () => {
    const params = currentFilterParams();
    const query = params.toString();
    history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
    refreshAggregatesAndRerender(params);
});

/* ------------------------------------------------------------ PDF export */

const exportPdfButton = document.getElementById('export-pdf-button');
const exportPdfLabel = document.getElementById('export-pdf-label');

exportPdfButton?.addEventListener('click', async () => {
    const corridorSelect = document.getElementById('filter-corridor');
    exportPdfButton.disabled = true;
    exportPdfLabel.textContent = 'Building PDF…';

    try {
        // Lazy: jsPDF only loads when someone actually exports.
        const { exportResultsPdf } = await import('./resultsPdf.js');
        const corridorId = corridorSelect?.value ?? '';
        await exportResultsPdf(data, {
            corridorId,
            corridorName: corridorSelect?.selectedOptions[0]?.textContent.trim() || 'All corridors',
            corridorUrl: corridorId ? data.corridorUrlTemplate.replace('__ID__', encodeURIComponent(corridorId)) : null,
        });
    } catch (error) {
        // eslint-disable-next-line no-alert
        alert(`PDF export failed: ${error.message}`);
    } finally {
        exportPdfButton.disabled = !data.aggregates?.length;
        exportPdfLabel.textContent = 'Export PDF';
    }
});

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
