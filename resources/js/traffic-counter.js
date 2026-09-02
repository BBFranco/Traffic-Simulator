/**
 * /traffic-counter page (Traffic Counter spec §4, §9). Three jobs:
 *   1. Let the user draw a counting line over the video's first frame, in
 *      native pixel space (canvas display size won't generally match the
 *      source resolution - scaled on submit, spec §4.3).
 *   2. Upload + poll `traffic-counts/{id}` until the queued job finishes.
 *   3. Render the finished stats/chart, or load a past count from the list.
 */

import {
    Chart,
    INK,
    applyChartTheme,
    baseOptions,
    barDataset,
    lineDataset,
} from './charts/theme.js';
import { onThemeChange } from './theme.js';

const data = JSON.parse(document.getElementById('traffic-counter-data').textContent);
const corridorsById = new Map(data.corridors.map((c) => [c.id, c]));

/* ------------------------------------------------------------- corridor/street picker */

const corridorSelect = document.getElementById('field-corridor');
const streetSelect = document.getElementById('field-street');
const corridorConfigCache = new Map();

async function fetchCorridor(id) {
    if (corridorConfigCache.has(id)) return corridorConfigCache.get(id);
    const url = data.corridorUrlTemplate.replace('__ID__', encodeURIComponent(id));
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Failed to load corridor "${id}" (HTTP ${response.status}).`);
    const config = await response.json();
    corridorConfigCache.set(id, config);
    return config;
}

/** Every arterial + connector in a corridor config, as {id, name, lanes, demand}. */
function streetsOf(config) {
    const arterials = (config.arterials ?? []).map((a) => ({
        id: a.id, name: a.shortName ?? a.name, lanes: a.lanes, demand: a.demand,
    }));
    const connectors = (config.connectors ?? []).map((c) => ({
        id: c.id, name: c.name, lanes: c.lanes, demand: c.demand,
    }));
    return [...arterials, ...connectors];
}

async function populateStreets() {
    const config = await fetchCorridor(corridorSelect.value);
    const streets = streetsOf(config);
    streetSelect.innerHTML = streets
        .map((s) => `<option value="${s.id}">${s.name}</option>`)
        .join('');
    return streets;
}

corridorSelect?.addEventListener('change', () => {
    populateStreets().catch((error) => showUploadError(error.message));
});
populateStreets().catch((error) => showUploadError(error.message));

/* ------------------------------------------------------------------- line drawing */

const videoEl = document.getElementById('frame-source');
const canvas = document.getElementById('line-canvas');
const canvasHint = document.getElementById('line-canvas-hint');
const ctx = canvas.getContext('2d');
const videoField = document.getElementById('field-video');
const clearLineButton = document.getElementById('clear-line-button');

/** Two {x, y} points in CANVAS display space; scaled to native video pixels on submit. */
let linePoints = [];
let sourceFrame = null; // ImageBitmap-ish: an HTMLVideoElement paused on frame 0, drawn each redraw
let nativeWidth = 0;
let nativeHeight = 0;

videoField?.addEventListener('change', () => {
    const file = videoField.files?.[0];
    if (!file) return;
    linePoints = [];
    sourceFrame = null;
    canvasHint.textContent = 'Loading frame...';
    const url = URL.createObjectURL(file);
    videoEl.src = url;
    videoEl.addEventListener(
        'loadeddata',
        async () => {
            nativeWidth = videoEl.videoWidth;
            nativeHeight = videoEl.videoHeight;
            const displayWidth = canvas.clientWidth || 480;
            canvas.width = displayWidth;
            canvas.height = Math.round((displayWidth * nativeHeight) / nativeWidth);

            // `loadeddata` only promises a frame is QUEUED, not that it's actually been
            // decoded/composited yet in every browser - drawImage() right after it can read
            // back blank until something else (e.g. a click, which re-runs redrawCanvas())
            // forces a repaint. A muted play()+immediate pause() forces a real decoded frame
            // to land before the first draw - the standard cross-browser fix for this.
            try {
                videoEl.muted = true;
                await videoEl.play();
                videoEl.pause();
            } catch {
                // Autoplay blocked in some contexts - draw whatever frame is ready anyway
                // rather than failing outright.
            }

            sourceFrame = videoEl;
            canvasHint.classList.add('hidden');
            canvas.classList.remove('hidden');
            redrawCanvas();
        },
        { once: true }
    );
    // Not every container/codec the upload form accepts (mimetypes: mp4/quicktime/webm/
    // x-msvideo, spec §4) is one the BROWSER can decode for the line-drawing preview - a
    // .mov or .avi commonly isn't. The upload itself still works either way (Python does
    // the real decoding server-side); this just tells the user why no frame appeared.
    videoEl.addEventListener(
        'error',
        () => {
            canvasHint.textContent = "Couldn't preview this video in the browser (unsupported format for playback) - try an MP4, or draw the line from a short MP4 clip of the same framing instead.";
            canvasHint.classList.remove('hidden');
        },
        { once: true }
    );
});

canvas.addEventListener('click', (event) => {
    if (!sourceFrame) return;
    if (linePoints.length >= 2) linePoints = [];
    const rect = canvas.getBoundingClientRect();
    linePoints.push({
        x: ((event.clientX - rect.left) / rect.width) * canvas.width,
        y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    });
    redrawCanvas();
});

clearLineButton?.addEventListener('click', () => {
    linePoints = [];
    redrawCanvas();
});

function redrawCanvas() {
    if (!sourceFrame) return;
    ctx.drawImage(sourceFrame, 0, 0, canvas.width, canvas.height);
    if (linePoints.length === 2) {
        ctx.strokeStyle = '#0ea5e9';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(linePoints[0].x, linePoints[0].y);
        ctx.lineTo(linePoints[1].x, linePoints[1].y);
        ctx.stroke();
    }
    linePoints.forEach((p) => {
        ctx.fillStyle = '#0ea5e9';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
    });
}

/** Canvas-space line points, scaled to the video's native resolution (spec §4.3). */
function lineCoordsInNativeSpace() {
    const scaleX = nativeWidth / canvas.width;
    const scaleY = nativeHeight / canvas.height;
    return linePoints.map((p) => ({ x: Math.round(p.x * scaleX), y: Math.round(p.y * scaleY) }));
}

/* ------------------------------------------------------------------------- upload */

const uploadForm = document.getElementById('upload-form');
const uploadSubmit = document.getElementById('upload-submit');
const uploadError = document.getElementById('upload-error');

function showUploadError(message) {
    uploadError.textContent = message;
    uploadError.classList.remove('hidden');
}

function clearUploadError() {
    uploadError.classList.add('hidden');
}

function csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content ?? '';
}

uploadForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearUploadError();

    const file = videoField.files?.[0];
    if (!file) return showUploadError('Choose a video file.');
    if (linePoints.length !== 2) return showUploadError('Draw the counting line (click two points on the frame).');

    const formData = new FormData();
    formData.append('video', file);
    formData.append('corridor_config', corridorSelect.value);
    formData.append('street', streetSelect.value);
    formData.append('label', document.getElementById('field-label').value);
    formData.append('line_coords', JSON.stringify(lineCoordsInNativeSpace()));
    formData.append('save_annotated_video', document.getElementById('field-save-annotated').checked ? '1' : '0');

    uploadSubmit.disabled = true;
    uploadSubmit.textContent = 'Uploading...';

    try {
        const response = await fetch(data.storeUrl, {
            method: 'POST',
            headers: { Accept: 'application/json', 'X-CSRF-TOKEN': csrfToken() },
            body: formData,
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.message ?? `Upload failed (HTTP ${response.status}).`);
        }
        const { id } = await response.json();
        addRecentCountRow(id, document.getElementById('field-label').value || `Count #${id}`, 'pending');
        pollStatus(id);
    } catch (error) {
        showUploadError(error.message);
    } finally {
        uploadSubmit.disabled = false;
        uploadSubmit.textContent = 'Upload & process';
    }
});

/* --------------------------------------------------------------- status polling */

const processingStatus = document.getElementById('processing-status');
const processingStatusLabel = document.getElementById('processing-status-label');
const resultsEmpty = document.getElementById('results-empty');
const resultsPanel = document.getElementById('results-panel');

const POLL_INTERVAL_MS = 3000;

function pollStatus(id) {
    resultsEmpty.classList.add('hidden');
    resultsPanel.classList.add('hidden');
    processingStatus.classList.remove('hidden');
    processingStatusLabel.textContent = 'Processing... this can take a few minutes.';

    const timer = setInterval(async () => {
        try {
            const url = data.statusUrlTemplate.replace('__ID__', id);
            const response = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!response.ok) throw new Error(`Status check failed (HTTP ${response.status}).`);
            const status = await response.json();

            if (status.status === 'done') {
                clearInterval(timer);
                processingStatus.classList.add('hidden');
                updateRecentCountRowStatus(id, 'done');
                await loadCount(id);
            } else if (status.status === 'failed') {
                clearInterval(timer);
                processingStatus.classList.add('hidden');
                updateRecentCountRowStatus(id, 'failed');
                resultsEmpty.classList.remove('hidden');
                resultsEmpty.textContent = `Processing failed: ${status.error_message ?? 'unknown error'}`;
            }
        } catch (error) {
            clearInterval(timer);
            processingStatus.classList.add('hidden');
            resultsEmpty.classList.remove('hidden');
            resultsEmpty.textContent = error.message;
        }
    }, POLL_INTERVAL_MS);
}

/* --------------------------------------------------------------------- results */

let volumeChart = null;
let lastLoadedCount = null;
let lastLoadedBuckets = null;

async function loadCount(id) {
    const url = data.dataUrlTemplate.replace('__ID__', id);
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Failed to load count #${id} (HTTP ${response.status}).`);
    const { count, buckets } = await response.json();

    resultsEmpty.classList.add('hidden');
    resultsPanel.classList.remove('hidden');

    lastLoadedCount = count;
    lastLoadedBuckets = buckets;

    renderQualityGrid(count);
    renderFitSummary(count);
    await renderVolumeChart(count, buckets);
    renderAnnotatedVideo(count);
}

function renderQualityGrid(count) {
    const grid = document.getElementById('quality-grid');
    const items = [
        ['Vehicles detected', count.vehicles_detected],
        ['Tracks counted', count.total_vehicles],
        ['Cars', count.cars_count],
        ['Trucks', count.trucks_count],
        ['Unclassified', count.unclassified_count],
        ['Frames processed', count.frames_processed],
        ['Duration (s)', count.observation_duration_seconds],
    ];
    grid.innerHTML = items
        .map(
            ([term, value]) => `
                <div>
                    <dt class="text-[10px] uppercase tracking-wider text-slate-500">${term}</dt>
                    <dd class="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">${value ?? '—'}</dd>
                </div>`
        )
        .join('');
}

function renderFitSummary(count) {
    const rows = [
        ['Observed mean', fmt(count.mean_flow)],
        ['Observed min', fmt(count.min_flow)],
        ['Observed max', fmt(count.max_flow)],
        ['Peak 5-min flow', fmt(count.peak_5min_flow)],
        ['Fitted mid', fmt(count.fitted_mid)],
        ['Fitted amplitude', fmt(count.fitted_amplitude)],
        ['Period (assumed)', count.assumed_period_seconds ? `${count.assumed_period_seconds} s` : '—'],
        ['R²', fmt(count.fitted_r_squared, 3)],
    ];
    document.getElementById('fit-summary-grid').innerHTML = rows
        .map(
            ([term, value]) => `
                <div class="flex items-baseline justify-between gap-2">
                    <dt class="text-slate-500">${term}</dt>
                    <dd class="font-semibold tabular-nums text-slate-900 dark:text-slate-100">${value}</dd>
                </div>`
        )
        .join('');
}

function fmt(value, decimals = 1) {
    return value === null || value === undefined ? '—' : Number(value).toFixed(decimals);
}

async function renderVolumeChart(count, buckets) {
    const config = corridorsById.has(count.corridor_config)
        ? await fetchCorridor(count.corridor_config)
        : null;
    const street = config ? streetsOf(config).find((s) => s.id === count.street) : null;

    const labels = buckets.map((b) => `${Math.round(b.bucket_start_seconds / 60)} min`);
    const observed = buckets.map((b) => b.vehicles_per_min);

    const period = count.assumed_period_seconds ?? street?.demand?.fluctuationPeriodS ?? 300;
    const fittedSeries = buckets.map((b) => {
        const t = b.bucket_start_seconds;
        // Re-derive a/b implicitly isn't possible from mid/amplitude alone (phase is lost),
        // so the fitted overlay plots the amplitude envelope centred on mid rather than a
        // phase-accurate curve - still an honest comparison of magnitude and swing.
        return count.fitted_mid + count.fitted_amplitude * Math.sin((2 * Math.PI * t) / period);
    });

    let assumedSeries = null;
    if (street?.demand) {
        const mid = (street.demand.spawnRatePerLanePerMinMin + street.demand.spawnRatePerLanePerMinMax) / 2;
        const amplitude = (street.demand.spawnRatePerLanePerMinMax - street.demand.spawnRatePerLanePerMinMin) / 2;
        assumedSeries = buckets.map(
            (b) => mid + amplitude * Math.sin((2 * Math.PI * b.bucket_start_seconds) / period)
        );
    }

    const datasets = [
        { ...barDataset({ label: 'Observed', data: observed, colour: '#0ea5e9' }), order: 3 },
        {
            ...lineDataset({ label: 'Fitted sinusoid', data: fittedSeries, colour: '#f97316' }),
            order: 1,
            borderDash: [],
        },
    ];
    if (assumedSeries) {
        datasets.push({
            ...lineDataset({ label: "Corridor's assumed demand", data: assumedSeries, colour: '#94a3b8' }),
            order: 2,
            borderDash: [6, 4],
        });
    }

    volumeChart?.destroy();
    volumeChart = new Chart(document.getElementById('chart-volume'), {
        type: 'bar',
        data: { labels, datasets },
        options: {
            ...baseOptions({ yTitle: 'veh/lane/min' }),
            plugins: { ...baseOptions().plugins, legend: { display: true, labels: { color: INK.secondary, boxWidth: 10 } } },
        },
    });
}

function renderAnnotatedVideo(count) {
    const wrap = document.getElementById('annotated-video-wrap');
    const player = document.getElementById('annotated-video');
    if (count.has_annotated_video) {
        player.src = data.videoUrlTemplate.replace('__ID__', count.id);
        wrap.classList.remove('hidden');
    } else {
        wrap.classList.add('hidden');
        player.removeAttribute('src');
    }
}

// Charts bake their ink in at construction (same convention as results.js), so a
// theme change rebuilds the volume chart wholesale rather than patching colours.
onThemeChange((theme) => {
    applyChartTheme(theme);
    if (lastLoadedCount) renderVolumeChart(lastLoadedCount, lastLoadedBuckets);
});

/* -------------------------------------------------------------- recent counts list */

const recentCountsList = document.getElementById('recent-counts-list');

recentCountsList?.addEventListener('click', (event) => {
    const row = event.target.closest('.recent-count-row');
    if (!row) return;
    const id = Number(row.dataset.countId);
    const status = row.querySelector('span:last-child')?.textContent?.trim();
    if (status === 'pending' || status === 'processing') {
        pollStatus(id);
    } else if (status === 'done') {
        loadCount(id).catch((error) => {
            resultsEmpty.classList.remove('hidden');
            resultsEmpty.textContent = error.message;
        });
    }
});

function addRecentCountRow(id, label, status) {
    const empty = recentCountsList.querySelector('li:only-child');
    if (empty && !empty.querySelector('button')) empty.remove();

    const li = document.createElement('li');
    li.innerHTML = `
        <button type="button" data-count-id="${id}"
                class="recent-count-row flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60">
            <span class="truncate">${label}</span>
            <span class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">${status}</span>
        </button>`;
    recentCountsList.prepend(li);
}

function updateRecentCountRowStatus(id, status) {
    const row = recentCountsList.querySelector(`.recent-count-row[data-count-id="${id}"]`);
    if (!row) return;
    const badge = row.querySelector('span:last-child');
    badge.textContent = status;
    badge.className =
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ' +
        (status === 'done'
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
            : status === 'failed'
              ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300'
              : 'bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300');
}
