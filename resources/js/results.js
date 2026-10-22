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
import { currentBuildStamp } from './buildStampClient.js';
import { buildExperimentalMatrix, seedForRep } from './sim/experimentalMatrix.js';
import { toApiPayload } from './sim/apiPayload.js';
import { accumulateRecoveryTicks, finalizeRecoveryTickPayload } from './sim/recoveryTickPayload.js';
import { probeConditions, probeVerdict, chooseWarmup, PROBE_REPLICATIONS } from './sim/warmupProbe.js';
import { MEASURED_TICKS, POWER_OUTAGE_START_TICK, POWER_OUTAGE_END_TICK, ROLLING_SCHEDULE } from './sim/batchSchedule.js';
import { describeLayoutDrift } from './sim/layoutDrift.js';
import batchWorkerUrl from './sim/batchWorker.js?worker&url';

const data = JSON.parse(document.getElementById('results-data').textContent);

/** The modes that read a sensor - broken out per sensor model as well as averaged. */
const SENSOR_SPLIT_MODES = ['adaptive', 'coordinated_adaptive'];

/** Fast lookup: "mode|power" -> aggregate row. Rebuilt after the batch-run button refreshes `data`. */
let byKey;

/** Fast lookup: "mode|sensor|power" -> aggregate row, the actuated modes' rows only (the only ones that vary by sensor). */
let byKeyBySensor;

function rebuildByKey() {
    byKey = new Map(data.aggregates.map((row) => [`${row.controller_mode}|${row.power_state}`, row]));
    byKeyBySensor = new Map(
        data.aggregatesBySensor
            .filter((row) => SENSOR_SPLIT_MODES.includes(row.controller_mode) && row.sensor_mode)
            .map((row) => [`${row.controller_mode}|${row.sensor_mode}|${row.power_state}`, row])
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
 * Which sensor mode the dropdown has selected for `mode`, or null for the blended average / another
 * target - in which case the charts keep reading the blended `data.aggregates` row.
 */
function selectedSensorFor(mode) {
    const target = selectedItsTarget();
    return target.mode === mode && SENSOR_SPLIT_MODES.includes(mode) && target.sensor && target.sensor !== 'average' ? target.sensor : null;
}

/** The aggregate row backing a mode's bar at a given power state - an actuated mode's row follows the dropdown's sensor pick. */
function rowForModeAndPower(mode, power) {
    const sensor = selectedSensorFor(mode);
    return sensor ? byKeyBySensor.get(`${mode}|${sensor}|${power}`) : byKey.get(`${mode}|${power}`);
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
 * An actuated mode's line-chart series for `metric` ('throughput_per_min' or 'avg_wait_time'):
 * the selected sensor's own recorded curve, or - for the blended "average of sensors" target -
 * a point-wise average across whichever of that mode's sensor curves were actually captured
 * (there's no literal run backing a blended curve, unlike the scalar aggregates() average, so
 * it's computed here instead of stored).
 */
function sensorRecoverySeries(timeline, metric, mode) {
    const key = scopedMetric(metric);
    const sensor = selectedSensorFor(mode);
    if (sensor) return timeline.series[`${mode}|${sensor}`]?.[key] ?? null;

    const sensorSeries = Object.keys(timeline.series)
        .filter((seriesKey) => seriesKey.startsWith(`${mode}|`))
        .map((seriesKey) => timeline.series[seriesKey][key]);
    if (!sensorSeries.length) return null;

    return sensorSeries[0].map((_, i) => one(sensorSeries.reduce((sum, s) => sum + s[i], 0) / sensorSeries.length));
}

/** A dark window's band label: every junction ("ALL ZONES DARK"), or the zones that went dark. */
function darkWindowLabel(zones) {
    if (!zones?.length) return 'ALL ZONES DARK';
    return `${zones.length > 1 ? 'ZONES' : 'ZONE'} ${zones.join(' + ')} DARK`;
}

/** The timeline's shaded bands, one per dark window - a curve without windows gets one from its outage start/end. */
function recoveryBands(timeline) {
    const windows = timeline.darkWindows?.length
        ? timeline.darkWindows
        : timeline.sheddingStart != null && timeline.sheddingEnd != null
          ? [{ zones: null, fromS: timeline.sheddingStart, toS: timeline.sheddingEnd }]
          : [];
    return windows.map((w) => ({
        from: nearestSecondIndex(timeline.seconds, w.fromS),
        to: nearestSecondIndex(timeline.seconds, w.toS),
        label: darkWindowLabel(w.zones),
    }));
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
        adaptive: sensorRecoverySeries(timeline, metric, 'adaptive'),
        coordinated_adaptive: sensorRecoverySeries(timeline, metric, 'coordinated_adaptive'),
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
                    // Category scale: each band is addressed by label index, not by seconds - one per
                    // dark window (a rolling blackout's zones each get their own).
                    xRangeBand: { bands: recoveryBands(timeline) },
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
 * Build steps 17-18: runs the full 30-condition x 30-rep experimental matrix
 * (900 headless runs - 30 conditions x 30 reps) in this tab and populates `simulation_runs`.
 *
 * `runHeadless()` here is the exact same function batch/runBatch.mjs calls
 * from the CLI - only the driver differs (a browser button instead of a
 * terminal), per the Phase 2 spec. It runs in a Web Worker
 * (sim/batchWorker.js) so the page stays responsive while it works.
 */
const REPS_PER_CONDITION = 30;
const DURATION_TICKS = MEASURED_TICKS; // sim/batchSchedule.js: 90 measured minutes, 60 of them after the power comes back
// Warm-up (run BEFORE anything is measured, discarded from every stat - see
// engine.js's resetStats()) is measured per corridor before each batch by
// sim/warmupProbe.js, not a constant: 360 s suits the small corridors, the
// 54-junction network needs tens of minutes.
// Load-shedding conditions cut power 15 min into the MEASURED window and restore it at 30 min (sim/batchSchedule.js).
const DT = 0.1;
const BASE_SEED = 20260101;
/** Batch the network writes - don't POST 600 times (build step 17). */
const POST_BATCH_SIZE = 25;

const batchButton = document.getElementById('batch-run-button');
const batchProgressWrap = document.getElementById('batch-progress-wrap');
const batchProgressBar = document.getElementById('batch-progress-bar');
const batchProgressLabel = document.getElementById('batch-progress-label');
const batchProgressPct = document.getElementById('batch-progress-pct');
const batchRunningBadge = document.getElementById('batch-running-badge');
const resumeBanner = document.getElementById('resume-banner');
const resumeBannerLabel = document.getElementById('resume-banner-label');
const resumeButton = document.getElementById('resume-batch-button');

let batchRunning = false;

batchButton?.addEventListener('click', () => openBatchModal());

/**
 * Runs the 900-run batch (unchanged from before the modal existed - only the
 * corridorConfig passed in can now carry per-street demand overrides from the
 * modal, see runBatchModal.js's docblock at the top of this section).
 *
 * `resume` (the latest batch's stored progress, /results/latest-batch-progress) carries a stopped batch on instead:
 * its own id, start time, warm-up, corridor, routing and demand, and only the runs the server doesn't hold yet. Runs are
 * taken and posted in matrix order, so what a batch stored is always a prefix of it; an outage condition cut off half
 * way reruns its stored reps without posting them, only to rebuild its recovery curve from every rep again.
 *
 * @param {Record<string, {min: number, max: number, saturationFlowPerLanePerHour: number}>} demandOverrides
 *   Keyed by street id (arterial or connector), spec §10-11.
 */
async function runBatch(demandOverrides, routingMode = 'random', resume = null) {
    if (batchRunning) return;
    batchRunning = true;
    batchButton.disabled = true;
    resumeBanner?.classList.add('hidden');
    batchRunningBadge?.classList.remove('hidden');
    document.getElementById('fake-data-badge')?.classList.add('hidden');
    document.getElementById('fake-data-banner')?.classList.add('hidden');
    if (batchProgressLabel) batchProgressLabel.textContent = resume ? 'Resuming...' : 'Starting...';
    if (batchProgressBar) batchProgressBar.style.width = '0%';
    if (batchProgressPct) batchProgressPct.textContent = '0%';
    batchProgressWrap?.classList.remove('hidden');

    let pool = null;

    try {
        pool = new BatchWorkerPool(batchWorkerCount());
        const corridorId = resume?.corridorConfig ?? (document.getElementById('filter-corridor')?.value || data.defaultCorridorId);
        const corridorConfig = applyDemandOverrides(await fetchCorridor(corridorId), demandOverrides);
        const matrix = buildExperimentalMatrix();
        const batchId = resume?.batchId ?? newBatchId();
        const batchStartedAt = resume?.batchStartedAt ?? new Date().toISOString();
        // A resume keeps the batch's own stamp, as runBatch.mjs --resume does - confirmResume() has checked the sim matches.
        const build = resume?.build ?? (await currentBuildStamp(__BUILD_STAMP__));
        batchMonitor.begin({ batchId, batchStartedAt, corridorId, routingMode, resumed: Boolean(resume), storedCount: resume?.runs.length ?? 0, poolSize: pool.size, build });

        const handPicked = handPickedWarmup();
        if (!resume && !handPicked) batchMonitor.phase('Warm-up probe');
        const warmup = resume?.warmup ?? handPicked ?? (await probeWarmup(pool, corridorConfig, routingMode));
        batchMonitor.setWarmup(warmup);
        const stored = new Set((resume?.runs ?? []).map((run) => storedRunKey(run.controllerMode, run.sensorMode, run.powerState, run.seed)));

        // Per condition, the reps still to run: none for a condition the server holds in full, the missing ones
        // otherwise - plus, for a cut-off outage condition, its stored reps again (not posted) for the recovery curve.
        const plan = matrix
            .map((condition) => {
                const reps = Array.from({ length: REPS_PER_CONDITION }, (_, rep) => {
                    const seed = seedForRep(BASE_SEED, condition.powerState, rep);
                    return { seed, isStored: stored.has(storedRunKey(condition.controllerMode, conditionSensor(condition), condition.powerState, seed)) };
                });
                const isOutage = condition.powerState !== 'normal';
                if (reps.every((rep) => rep.isStored)) return null;
                return { condition, reps: isOutage ? reps : reps.filter((rep) => !rep.isStored) };
            })
            .filter(Boolean);
        const totalRuns = plan.reduce((sum, { reps }) => sum + reps.length, 0);
        batchMonitor.setPlan(matrix, plan);
        const post = async (runs) => {
            await postSimulationRuns(runs);
            batchMonitor.posted(runs.length);
        };

        let completed = 0;
        let pending = [];
        const startedAtMs = performance.now();
        if (batchProgressLabel) batchProgressLabel.textContent = resume ? `Resuming with ${stored.size} runs already saved, ${pool.size} at a time...` : `Running ${pool.size} at a time...`;

        // Every run in matrix order; the pool works through them side by side, but results are
        // taken (and each condition's recovery curve built) in the same order as one at a time,
        // so the dataset is identical. Only a few pool-widths run ahead, since every finished
        // run holds its per-tick rows until it is taken.
        const jobs = plan.flatMap(({ condition, reps }) =>
            reps.map(({ seed, isStored }) => ({
                condition,
                isStored,
                options: {
                    seed,
                    controllerMode: condition.controllerMode,
                    sensorMode: condition.sensorMode,
                    warmupTicks: warmup.warmupTicks,
                    powerOutageStartTick: condition.powerState === 'load_shedding' ? POWER_OUTAGE_START_TICK : null,
                    powerOutageEndTick: condition.powerState === 'load_shedding' ? POWER_OUTAGE_END_TICK : null,
                    rollingSchedule: condition.powerState === 'rolling_blackout' ? ROLLING_SCHEDULE : null,
                    corridorConfig,
                    durationTicks: DURATION_TICKS,
                    dt: DT,
                    routingMode,
                },
            }))
        );
        const runAhead = pool.size * 3;
        let started = 0;
        const topUp = (takenIndex) => {
            while (started < jobs.length && started < takenIndex + runAhead) {
                const job = jobs[started];
                batchMonitor.jobStarted(job.condition.key);
                job.result = pool.run('run', job.options).then((result) => {
                    completed += 1;
                    batchMonitor.jobFinished(job.condition.key, job.isStored);
                    updateBatchProgress(completed, totalRuns, job.condition.key, performance.now() - startedAtMs);
                    return result;
                });
                started += 1;
            }
        };

        let jobIndex = 0;
        for (const { condition, reps } of plan) {
            let recoveryAcc = null;
            let darkWindows = null;
            const rollingSchedule = condition.powerState === 'rolling_blackout' ? ROLLING_SCHEDULE : null;

            for (let rep = 0; rep < reps.length; rep += 1) {
                topUp(jobIndex);
                const { isStored } = jobs[jobIndex];
                // eslint-disable-next-line no-await-in-loop
                const { sideStreetRows, totalRows, arterialScopeRows, summary } = await jobs[jobIndex].result;
                jobs[jobIndex] = null; // let its rows go
                jobIndex += 1;

                if (!isStored) {
                    const payload = toApiPayload(summary, batchId, { warmupStationary: warmup.stationary, warmupDrifting: warmup.drifting ?? null, warmupSettle: warmup.settle ?? null, batchStartedAt, build });
                    // What a resume needs to run the same demand again.
                    payload.raw_config_json.demandOverrides = demandOverrides;
                    pending.push(payload);
                }

                // Every rep of an outage condition folds into this condition's recovery
                // curve, so the chart averages the same population the "time to recovery" stat
                // card does - posted once after the last rep, not batched with the summary POSTs.
                if (condition.powerState !== 'normal') {
                    recoveryAcc = accumulateRecoveryTicks(recoveryAcc, { totalRows, arterialScopeRows, sideStreetRows });
                    darkWindows = summary.darkWindows;
                }

                if (pending.length >= POST_BATCH_SIZE) {
                    await post(pending.splice(0, pending.length));
                }
            }

            if (recoveryAcc) {
                await postRecoveryTicks(
                    finalizeRecoveryTickPayload(recoveryAcc, {
                        controllerMode: condition.controllerMode,
                        sensorMode: condition.sensorMode,
                        corridorId: corridorConfig.id,
                        dt: DT,
                        // A rolling blackout's curve spans its first cut to its final restore.
                        powerOutageStartTick: rollingSchedule ? rollingSchedule[0].fromTick : POWER_OUTAGE_START_TICK,
                        powerOutageEndTick: rollingSchedule ? rollingSchedule[rollingSchedule.length - 1].toTick : POWER_OUTAGE_END_TICK,
                        routingMode,
                        powerState: condition.powerState,
                        darkWindows,
                    })
                );
                batchMonitor.curvePosted(condition.key);
            }
        }

        if (batchProgressLabel) batchProgressLabel.textContent = 'Saving results...';
        if (pending.length) await post(pending);

        if (batchProgressLabel) batchProgressLabel.textContent = 'Refreshing charts...';
        // Show what was just run: its routing mode's latest batch.
        const routingFilter = document.getElementById('filter-routing');
        if (routingFilter) routingFilter.value = routingMode;
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
        alert(`Batch run failed: ${error.message}\n\nWhat it saved is kept - Resume batch carries on from there.`);
    } finally {
        pool?.terminate();
        batchMonitor.end();
        batchRunning = false;
        batchButton.disabled = false;
        batchButton.textContent = `Generate dataset (${buildExperimentalMatrix().length * REPS_PER_CONDITION} runs)`;
        batchRunningBadge?.classList.add('hidden');
        batchProgressWrap?.classList.add('hidden');
        checkForUnfinishedBatch();
    }
}

/** A stored run as resume matches it: condition and seed - fixed-time stores no sensor (apiPayload.js). */
function storedRunKey(controllerMode, sensorMode, powerState, seed) {
    return [controllerMode, sensorMode ?? '', powerState, seed].join('|');
}

function conditionSensor(condition) {
    return condition.controllerMode === 'fixed' ? null : condition.sensorMode;
}

/** The latest batch's stored progress, kept for the Resume button while it is short of the full matrix. */
let unfinishedBatch = null;

/** Shows the Resume banner when the latest batch stopped short of the full matrix (a crash, a closed tab, a server restart). */
async function checkForUnfinishedBatch() {
    if (!resumeBanner || !data.latestBatchProgressUrl) return;
    let progress = null;
    try {
        const response = await fetch(data.latestBatchProgressUrl, { headers: { Accept: 'application/json' } });
        progress = response.ok ? await response.json() : null;
    } catch {
        progress = null;
    }
    const expected = buildExperimentalMatrix().length * REPS_PER_CONDITION;
    unfinishedBatch = progress && progress.runs.length < expected ? progress : null;
    resumeBanner.classList.toggle('hidden', !unfinishedBatch || batchRunning);
    if (!unfinishedBatch) return;
    const startedAt = unfinishedBatch.batchStartedAt ? new Date(unfinishedBatch.batchStartedAt).toLocaleString() : 'an unknown time';
    resumeBannerLabel.textContent = `The batch started ${startedAt} (${unfinishedBatch.corridorConfig}, ${unfinishedBatch.routingMode} routing) stopped with ${unfinishedBatch.runs.length} of ${expected} runs saved.`;
}

/**
 * Whether this page may carry the batch on: the same simulation code (the build stamp's `sim` fingerprint) - or, for a
 * batch stamped before the fingerprint existed, the user's word for it after seeing both commits.
 */
async function confirmResume(progress) {
    const then = progress.build ?? {};
    const now = await currentBuildStamp(__BUILD_STAMP__);
    if (then.sim && now.sim) {
        if (then.sim === now.sim) return true;
        // eslint-disable-next-line no-alert
        alert(`This batch ran on different simulation code (${then.commit ?? '?'}, sim ${then.sim}) than this page has (${now.commit ?? '?'}, sim ${now.sim}). Resuming would mix two engines in one batch - start a new one instead.`);
        return false;
    }
    const code = (stamp) => `${stamp.commit ?? 'unknown commit'}${stamp.dirty == null ? ' (tree state unknown)' : stamp.dirty ? ' with uncommitted changes' : ''}`;
    const demand = progress.demandOverrides ? '' : "\n\nIts demand settings were not recorded, so it resumes on the corridor's own demand (the dialog's defaults).";
    // eslint-disable-next-line no-alert
    return window.confirm(`This batch was started on code ${code(then)}; this page runs ${code(now)}. It predates the simulation-code fingerprint, so the match can't be checked - resume only if resources/js/sim is unchanged since.${demand}\n\nResume?`);
}

resumeButton?.addEventListener('click', async () => {
    if (!unfinishedBatch || batchRunning || !(await confirmResume(unfinishedBatch))) return;
    runBatch(unfinishedBatch.demandOverrides ?? {}, unfinishedBatch.routingMode ?? 'random', unfinishedBatch);
});

checkForUnfinishedBatch();

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

/**
 * Measures this corridor's warm-up before the batch (sim/warmupProbe.js): long
 * from-empty runs per controller, all side by side on the pool, then each
 * controller's runs averaged in seed order and the slowest levelling-off point
 * plus margin taken. Logged to the console so the choice can be checked.
 */
/**
 * `/results?warmup=60` runs the batch on a hand-picked warm-up (minutes) instead of probing - for when the probe's
 * 3-seed verdict is known to be noise (2026-10-22: a false "drifting" on fixed-time side streets capped it at 90 min,
 * while 6 seeds from empty were level from 40 min). Stored as runBatch.mjs's --warmup-ticks is: stationary null.
 */
function handPickedWarmup() {
    const minutes = Number(new URLSearchParams(window.location.search).get('warmup'));
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return { warmupTicks: Math.round((minutes * 60) / DT), stationary: null, drifting: null, settle: null };
}

async function probeWarmup(pool, corridorConfig, routingMode) {
    const conditions = probeConditions();
    const seeds = Array.from({ length: PROBE_REPLICATIONS }, (_, rep) => seedForRep(BASE_SEED, 'normal', rep));
    const totalRuns = conditions.length * seeds.length;
    let finished = 0;
    const showProgress = () => {
        if (batchProgressLabel) batchProgressLabel.textContent = `Finding warm-up · ${finished}/${totalRuns} probe runs (${pool.size} at a time)...`;
        batchMonitor.phase(`Warm-up probe · ${finished}/${totalRuns}`);
    };
    showProgress();
    const probes = await Promise.all(
        conditions.map(async (condition) => {
            const runs = await Promise.all(
                seeds.map((seed) =>
                    pool.run('probeSeries', { ...condition, corridorConfig, seed, dt: DT, routingMode }).then((series) => {
                        finished += 1;
                        showProgress();
                        return series;
                    })
                )
            );
            return probeVerdict({ ...condition, runs, dt: DT, measuredTicks: DURATION_TICKS });
        })
    );
    const warmup = chooseWarmup(probes);
    // eslint-disable-next-line no-console
    console.info(`Batch warm-up: ${warmup.warmupTicks} ticks (${((warmup.warmupTicks * DT) / 60).toFixed(0)} min), ${warmup.stationary ? 'stationary' : 'NOT stationary - capped'}`, warmup.probes);
    return warmup;
}

/**
 * One worker per logical core, less one for the page itself; capped so a big machine never holds dozens of runs' rows
 * at once (~210 MB each). On 8 cores / 16 threads, 15 workers clear ~6% more than 12 (2026-10-13 benchmark).
 */
const MAX_BATCH_WORKERS = 15;
function batchWorkerCount() {
    return Math.max(1, Math.min(MAX_BATCH_WORKERS, (navigator.hardwareConcurrency || 2) - 1));
}

/**
 * A fixed set of batch workers (sim/batchWorker.js): `run()` queues a task and
 * resolves with its result once a free worker has done it. Every run is fully
 * determined by its own options (seed included), so which worker does it, and
 * when, never changes the result.
 */
class BatchWorkerPool {
    constructor(size) {
        this.size = size;
        this.queue = [];
        this.idle = Array.from({ length: size }, () => createBatchWorker());
        this.all = [...this.idle];
        this.nextId = 0;
    }

    run(task, options) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, options, resolve, reject });
            this._dispatch();
        });
    }

    _dispatch() {
        while (this.idle.length && this.queue.length) {
            const worker = this.idle.pop();
            const { task, options, resolve, reject } = this.queue.shift();
            const id = ++this.nextId;
            const cleanUp = () => {
                worker.removeEventListener('message', onMessage);
                worker.removeEventListener('error', onError);
                this.idle.push(worker);
                this._dispatch();
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
            worker.postMessage({ id, task, options });
        }
    }

    terminate() {
        for (const worker of this.all) worker.terminate();
        this.queue = [];
    }
}

/** Success toast + a brief fireworks burst when the 600-run batch finishes. */
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

/** "45s", "12m 05s", "1h 03m" - coarse enough for a batch ETA. */
function formatDuration(ms) {
    const totalS = Math.max(1, Math.round(ms / 1000));
    const h = Math.floor(totalS / 3600);
    const m = Math.floor((totalS % 3600) / 60);
    const s = totalS % 60;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
}

/* ---------------------------------------------------------- batch monitor */

const batchMeta = document.getElementById('batch-progress-meta');
const batchDetails = document.getElementById('batch-details');
const batchDetailsToggle = document.getElementById('batch-details-toggle');
const batchDetailsChevron = document.getElementById('batch-details-chevron');
const batchDetailsFacts = document.getElementById('batch-details-facts');
const batchDetailsConditions = document.getElementById('batch-details-conditions');
const BATCH_DETAILS_KEY = 'results.batchDetailsOpen';
const SENSOR_SHORT = { inductive_loop: 'loop', radar: 'radar', camera: 'camera', magnetometer: 'magnetometer' };

function setBatchDetailsOpen(open) {
    batchDetails?.classList.toggle('hidden', !open);
    batchDetailsChevron?.classList.toggle('rotate-180', open);
    batchDetailsToggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
    try {
        localStorage.setItem(BATCH_DETAILS_KEY, open ? '1' : '0');
    } catch {
        // Private window or blocked storage - the panel just opens closed next time.
    }
}

batchDetailsToggle?.addEventListener('click', () => setBatchDetailsOpen(batchDetails?.classList.contains('hidden')));
try {
    setBatchDetailsOpen(localStorage.getItem(BATCH_DETAILS_KEY) === '1');
} catch {
    setBatchDetailsOpen(false);
}

/** The batch's code as the report's cover reads it (ResultsController::treeState()) - clean only when a check said so. */
function buildLabel(build) {
    if (!build?.commit) return 'commit unknown';
    if (build.source === 'vite-dev' && build.fresh !== true) return `${build.commit} · tree state not checked`;
    if (build.dirty == null) return `${build.commit} · tree state unknown`;
    return `${build.commit} · ${build.dirty ? 'dirty (uncommitted changes)' : 'clean'}`;
}

/**
 * The running batch as the Details panel shows it: what kind of batch (routing, corridor, new or resumed, warm-up,
 * workers) and, per condition, its runs saved earlier, finished, running and still to go, plus its recovery curve.
 * Display only - it reads what runBatch() reports and steers nothing.
 */
const batchMonitor = {
    state: null,
    frame: null,

    begin({ batchId, batchStartedAt, corridorId, routingMode, resumed, storedCount, poolSize, build }) {
        this.state = { batchId, batchStartedAt, corridorId, routingMode, resumed, storedCount, poolSize, build, phase: 'Starting', warmup: null, conditions: [], startedAtMs: performance.now(), runsDone: 0, runsTotal: 0, posted: 0 };
        this.render();
    },

    phase(text) {
        if (!this.state) return;
        this.state.phase = text;
        this.render();
    },

    setWarmup(warmup) {
        this.state.warmup = warmup;
        this.render();
    },

    /** `plan` from runBatch(): every condition of the matrix, with how many of its reps are saved, to run, and rerun. */
    setPlan(matrix, plan) {
        const planned = new Map(plan.map((entry) => [entry.condition.key, entry]));
        this.state.conditions = matrix.map((condition) => {
            const entry = planned.get(condition.key);
            const saved = entry ? entry.reps.filter((rep) => rep.isStored).length : REPS_PER_CONDITION;
            const isOutage = condition.powerState !== 'normal';
            return {
                condition,
                saved: entry ? saved : REPS_PER_CONDITION,
                toRun: entry ? entry.reps.filter((rep) => !rep.isStored).length : 0,
                reruns: entry && isOutage ? saved : 0,
                finished: 0,
                rerunsDone: 0,
                running: 0,
                isOutage,
                // A condition held in full before this run already posted its curve.
                curve: entry ? 'pending' : isOutage ? 'posted' : null,
            };
        });
        this.state.runsTotal = plan.reduce((sum, { reps }) => sum + reps.length, 0);
        this.state.phase = 'Running';
        this.render();
    },

    _row(key) {
        return this.state?.conditions.find((row) => row.condition.key === key);
    },

    jobStarted(key) {
        const row = this._row(key);
        if (row) row.running += 1;
        this.render();
    },

    jobFinished(key, isStored) {
        const row = this._row(key);
        if (row) {
            row.running = Math.max(0, row.running - 1);
            if (isStored) row.rerunsDone += 1;
            else row.finished += 1;
        }
        this.state.runsDone += 1;
        this.render();
    },

    posted(count) {
        this.state.posted += count;
        this.render();
    },

    curvePosted(key) {
        const row = this._row(key);
        if (row) row.curve = 'posted';
        this.render();
    },

    end() {
        this.state = null;
    },

    render() {
        if (this.frame != null) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = null;
            this._draw();
        });
    },

    _draw() {
        const s = this.state;
        if (!s) return;
        const routing = s.routingMode === 'destination' ? 'Destination routing' : 'Random turning';
        const kind = s.resumed ? `resumed batch (${s.storedCount} runs saved earlier)` : 'new batch';
        const warmupMin = s.warmup ? Math.round((s.warmup.warmupTicks * DT) / 60) : null;
        const code = buildLabel(s.build);
        if (batchMeta) {
            batchMeta.textContent = [routing, s.corridorId, kind, code, `${s.poolSize} at a time`, warmupMin != null ? `warm-up ${warmupMin} min` : 'finding warm-up'].join(' · ');
        }

        const elapsedMs = performance.now() - s.startedAtMs;
        const remainingMs = s.runsDone ? (elapsedMs / s.runsDone) * (s.runsTotal - s.runsDone) : null;
        const curves = s.conditions.filter((row) => row.isOutage);
        const facts = [
            ['Routing', routing],
            ['Corridor', s.corridorId],
            ['Batch', s.resumed ? `Resumed · ${s.storedCount} saved earlier` : 'New'],
            ['Batch id', s.batchId.slice(0, 8), s.batchId],
            ['Code', code, [s.build?.source, s.build?.sim && `sim ${s.build.sim}`].filter(Boolean).join(' · ')],
            ['Started', s.batchStartedAt ? new Date(s.batchStartedAt).toLocaleString() : '-'],
            ['Phase', s.phase],
            ['Warm-up', s.warmup ? `${warmupMin} min (${s.warmup.warmupTicks} ticks)${s.warmup.stationary === false ? ' · not stationary' : s.warmup.stationary === null ? ' · set by hand' : ''}` : 'probing...'],
            ['Workers', `${s.poolSize} runs at a time`],
            ['Runs this session', `${s.runsDone} / ${s.runsTotal}`],
            ['Posted', `${s.posted} runs`],
            ['Recovery curves', `${curves.filter((row) => row.curve === 'posted').length} / ${curves.length} posted`],
            ['Elapsed', `${formatDuration(elapsedMs)}${remainingMs != null && s.runsDone < s.runsTotal ? ` · ~${formatDuration(remainingMs)} left` : ''}`],
        ];
        batchDetailsFacts?.replaceChildren(
            ...facts.map(([term, value, title]) => {
                const wrap = document.createElement('div');
                const dt = document.createElement('dt');
                dt.className = 'text-[10px] font-semibold uppercase tracking-wider text-sky-700/80 dark:text-sky-400/80';
                dt.textContent = term;
                const dd = document.createElement('dd');
                dd.className = 'tabular-nums';
                dd.textContent = value;
                if (title) dd.title = title;
                wrap.append(dt, dd);
                return wrap;
            })
        );

        const byPower = new Map();
        for (const row of s.conditions) {
            if (!byPower.has(row.condition.powerState)) byPower.set(row.condition.powerState, []);
            byPower.get(row.condition.powerState).push(row);
        }
        batchDetailsConditions?.replaceChildren(
            ...[...byPower].map(([power, rows]) => {
                const column = document.createElement('section');
                const heading = document.createElement('h3');
                heading.className = 'mb-2 text-[10px] font-semibold uppercase tracking-wider text-sky-800 dark:text-sky-300';
                const done = rows.reduce((sum, row) => sum + row.saved + row.finished, 0);
                heading.textContent = `${POWER_LABELS[power] ?? power} · ${done} / ${rows.length * REPS_PER_CONDITION}`;
                const list = document.createElement('ul');
                list.className = 'space-y-1.5';
                list.append(...rows.map((row) => this._conditionRow(row)));
                column.append(heading, list);
                return column;
            })
        );
    },

    _conditionRow(row) {
        const { condition } = row;
        const item = document.createElement('li');
        item.className = 'grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-[11px] text-sky-900 dark:text-sky-200';

        const label = document.createElement('span');
        label.className = 'truncate';
        const sensor = condition.controllerMode === 'adaptive' || condition.controllerMode === 'coordinated_adaptive' ? ` · ${SENSOR_SHORT[condition.sensorMode] ?? condition.sensorMode}` : '';
        label.textContent = `${MODE_LABELS[condition.controllerMode] ?? condition.controllerMode}${sensor}`;
        label.title = condition.key;

        const track = document.createElement('span');
        track.className = 'flex h-2 overflow-hidden rounded-full bg-sky-200/70 dark:bg-sky-900/60';
        const segment = (count, colour) => {
            const bar = document.createElement('span');
            bar.className = `h-full ${colour}`;
            bar.style.width = `${(count / REPS_PER_CONDITION) * 100}%`;
            return bar;
        };
        track.append(segment(row.saved, 'bg-sky-300 dark:bg-sky-700'), segment(row.finished, 'bg-sky-600 dark:bg-sky-400'), segment(Math.min(row.running, row.toRun - row.finished), 'bg-amber-400'));

        const status = document.createElement('span');
        status.className = 'whitespace-nowrap tabular-nums';
        const count = row.saved + row.finished;
        const complete = count >= REPS_PER_CONDITION && row.curve !== 'pending';
        const parts = [`${count}/${REPS_PER_CONDITION}`];
        if (row.reruns) parts.push(`rerun ${row.rerunsDone}/${row.reruns}`);
        if (row.isOutage) parts.push(row.curve === 'posted' ? 'curve ✓' : 'curve -');
        parts.push(complete ? 'done' : row.running ? 'running' : count || row.rerunsDone ? 'waiting' : 'queued');
        status.textContent = parts.join(' · ');
        if (complete) status.classList.add('text-emerald-700', 'dark:text-emerald-400');
        else if (row.running) status.classList.add('font-semibold');

        item.append(label, track, status);
        return item;
    },
};

function updateBatchProgress(completed, total, conditionKey, elapsedMs) {
    const pct = Math.round((completed / total) * 100);
    // Average time per finished run so far, times the runs still to go.
    const remainingMs = (elapsedMs / completed) * (total - completed);
    const eta = completed < total ? ` · ~${formatDuration(remainingMs)} left` : '';
    if (batchProgressBar) batchProgressBar.style.width = `${pct}%`;
    if (batchProgressPct) batchProgressPct.textContent = `${pct}% · ${completed}/${total} runs${eta}`;
    if (batchProgressLabel) batchProgressLabel.textContent = `Last finished: ${conditionKey}`;
    if (batchButton) batchButton.textContent = `Running... ${completed}/${total}`;
}

async function fetchCorridor(id) {
    const url = data.corridorUrlTemplate.replace('__ID__', encodeURIComponent(id));
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Failed to load corridor "${id}" (HTTP ${response.status}).`);
    return response.json();
}

/* ============================================================ batch modal (spec §10-11) */

/**
 * Every arterial + connector in a corridor config that has demand of its own, in the same
 * shape a demand row needs, typed by measurement scope rather than by road kind (an arterial
 * with scope "side" is a side street, a connector with scope "arterial" is an arterial). Roads with no `demand` (a merge road, a turn road) only carry
 * cars handed on from another road, so there is nothing to set for them.
 */
function streetsOf(corridorConfig) {
    const arterials = (corridorConfig.arterials ?? []).map((a) => ({
        id: a.id, name: a.shortName ?? a.name, demand: a.demand, type: a.scope === 'side' ? 'side-street' : 'arterial',
    }));
    const connectors = (corridorConfig.connectors ?? []).map((c) => ({
        id: c.id, name: c.name, demand: c.demand, type: c.scope === 'arterial' ? 'arterial' : 'side-street',
    }));
    return [...arterials, ...connectors].filter((street) => street.demand);
}

/** Badge styling per street type - the only thing that visually told the batch modal's
 * cards apart before this was their (identical) border colour. */
const STREET_TYPE_BADGES = {
    arterial: {
        label: 'Arterial',
        classes: 'border border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-300',
    },
    'side-street': {
        label: 'Side street',
        classes: 'border border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300',
    },
};

const batchModalBackdrop = document.getElementById('batch-modal-backdrop');
const batchModalStreets = document.getElementById('batch-modal-streets');

async function openBatchModal() {
    if (batchRunning) return;
    batchModalBackdrop?.classList.remove('hidden');
    batchModalStreets.innerHTML = '<p class="text-xs text-slate-400">Loading corridor…</p>';

    renderBatchModalDrift([]);

    try {
        const corridorId = document.getElementById('filter-corridor')?.value || data.defaultCorridorId;
        const [corridorConfig, savedLayout] = await Promise.all([fetchCorridor(corridorId), fetchSavedLayout(corridorId)]);
        renderBatchModalStreets(corridorConfig, corridorId);
        renderBatchModalDrift(savedLayout ? describeLayoutDrift(savedLayout, corridorConfig) : []);
    } catch (error) {
        batchModalStreets.innerHTML = `<p class="text-xs text-red-600 dark:text-red-400">${error.message}</p>`;
    }
}

/** The user's own copy of the corridor (Road Editor / Simulator) - null when they have none under that id, or it can't be loaded. */
async function fetchSavedLayout(id) {
    try {
        const response = await fetch(data.savedLayoutUrlTemplate.replace('__ID__', encodeURIComponent(id)), { headers: { Accept: 'application/json' } });
        return response.ok ? await response.json() : null;
    } catch {
        return null;
    }
}

/** Warns that the batch runs on the template, not the Road Editor's edits, when the two differ. */
function renderBatchModalDrift(parts) {
    const box = document.getElementById('batch-modal-drift');
    if (!box) return;
    box.classList.toggle('hidden', parts.length === 0);
    box.replaceChildren();
    if (!parts.length) return;
    const strong = document.createElement('strong');
    strong.className = 'font-semibold';
    strong.textContent = 'Your saved layout differs from the template this batch runs on: ';
    box.append(strong, `${parts.join(', ')}. The batch uses the template file (corridors/*.json), not your Road Editor edits - copy them into the template first if they should count.`);
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
    const routingMode = document.getElementById('batch-modal-destination')?.checked ? 'destination' : 'random';
    closeBatchModal();
    runBatch(overrides, routingMode);
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
    if (!response.ok) throw new Error(`GET ${data.resultsDataUrl} -> ${response.status}`);

    const fresh = await response.json();
    Object.assign(data, fresh);
    rebuildByKey();
    document.getElementById('non-stationary-banner')?.classList.toggle('hidden', !fresh.hasNonStationaryBatch);
    document.getElementById('non-stationary-culprit')?.classList.toggle('hidden', !fresh.warmupDriftingLabel);
    const culpritLabel = document.getElementById('non-stationary-culprit-label');
    if (culpritLabel) culpritLabel.textContent = fresh.warmupDriftingLabel ?? '';
    document.getElementById('lockup-banner')?.classList.toggle('hidden', !fresh.lockupLabel);
    const lockupLabel = document.getElementById('lockup-label');
    if (lockupLabel) lockupLabel.textContent = fresh.lockupLabel ?? '';
    document.getElementById('starved-banner')?.classList.toggle('hidden', !fresh.starvedLabel);
    const starvedLabel = document.getElementById('starved-label');
    if (starvedLabel) starvedLabel.textContent = fresh.starvedLabel ?? '';

    if (fresh.html) {
        const setHtml = (id, html) => {
            const el = document.getElementById(id);
            if (el && html !== undefined) el.innerHTML = html;
        };
        setHtml('batch-summary', fresh.html.batchSummary);
        setHtml('research-question-cards', fresh.html.researchQuestionCards);
        setHtml('metric-section-groups', fresh.html.metricSectionGroups);
        setHtml('routing-metrics', fresh.html.routingMetrics);

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
    if (exportCsvButton) exportCsvButton.disabled = !data.aggregates?.length;
    document.getElementById('fake-data-badge')?.classList.add('hidden');
    document.getElementById('fake-data-banner')?.classList.add('hidden');
}

function currentFilterParams() {
    const params = new URLSearchParams();
    const corridor = document.getElementById('filter-corridor')?.value;
    if (corridor) params.set('corridor', corridor);
    const routing = document.getElementById('filter-routing')?.value;
    if (routing && routing !== 'random') params.set('routing', routing);
    return params;
}

for (const filterId of ['filter-corridor', 'filter-routing']) {
    document.getElementById(filterId)?.addEventListener('change', () => {
        const params = currentFilterParams();
        const query = params.toString();
        history.replaceState(null, '', query ? `?${query}` : window.location.pathname);
        refreshAggregatesAndRerender(params).catch((error) => {
            // eslint-disable-next-line no-alert
            alert(`Could not load results for this selection: ${error.message}`);
        });
    });
}

/* ------------------------------------------------------------ PDF export */

const exportPdfButton = document.getElementById('export-pdf-button');
const exportPdfLabel = document.getElementById('export-pdf-label');

exportPdfButton?.addEventListener('click', async () => {
    const corridorSelect = document.getElementById('filter-corridor');
    exportPdfButton.disabled = true;
    exportPdfLabel.textContent = 'Building PDF…';

    try {
        // The dropdown can disagree with the loaded data (browser-restored select value, or a failed
        // refresh) - the cover/layout come from the dropdown, the numbers from `data`, so re-sync first.
        await refreshAggregatesAndRerender();
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

/* ------------------------------------------------------------ CSV export */

const exportCsvButton = document.getElementById('export-csv-button');

exportCsvButton?.addEventListener('click', async () => {
    exportCsvButton.disabled = true;

    try {
        // Same re-sync as the PDF: the dropdown can disagree with the loaded data.
        await refreshAggregatesAndRerender();
        const { exportResultsCsv } = await import('./resultsCsv.js');
        exportResultsCsv(data, { corridorId: document.getElementById('filter-corridor')?.value ?? '' });
    } catch (error) {
        // eslint-disable-next-line no-alert
        alert(`CSV export failed: ${error.message}`);
    } finally {
        exportCsvButton.disabled = !data.aggregates?.length;
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
        const sensorMatches = !SENSOR_SPLIT_MODES.includes(mode) || sensor === 'average' || row.dataset.runSensorMode === sensor;
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
