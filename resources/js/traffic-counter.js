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

const RECENT_COUNTS_LIMIT = 10;
const recentCountsList = document.getElementById('recent-counts-list');

function badgeClass(status) {
    return (
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ' +
        (status === 'done'
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
            : status === 'failed'
              ? 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300'
              : 'bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300')
    );
}

function recentCountRowHtml(id, label, status) {
    return `
        <li class="group flex items-center gap-1" data-count-id="${id}">
            <button type="button" data-count-id="${id}"
                    class="recent-count-row flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60">
                <span class="truncate">${label}</span>
                <span class="${badgeClass(status)}">${status}</span>
            </button>
            <button type="button" data-delete-count-id="${id}" title="Delete count"
                    class="delete-count-row shrink-0 rounded px-1.5 py-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400">
                &times;
            </button>
        </li>`;
}

recentCountsList?.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('.delete-count-row');
    if (deleteButton) {
        deleteCount(Number(deleteButton.dataset.deleteCountId));
        return;
    }

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

/** Deletes a count and reflects the removal in whichever list(s) reference it. */
async function deleteCount(id) {
    if (!window.confirm('Delete this count? This removes its video and results permanently.')) return;

    try {
        const url = data.deleteUrlTemplate.replace('__ID__', id);
        const response = await fetch(url, {
            method: 'DELETE',
            headers: { Accept: 'application/json', 'X-CSRF-TOKEN': csrfToken() },
        });
        if (!response.ok) throw new Error(`Failed to delete count (HTTP ${response.status}).`);

        if (lastLoadedCount?.id === id) {
            resultsPanel.classList.add('hidden');
            resultsEmpty.classList.remove('hidden');
            resultsEmpty.textContent = 'Upload a video, or pick a finished count from the list, to see its flow stats here.';
            lastLoadedCount = null;
            lastLoadedBuckets = null;
        }

        recentCountsList.querySelector(`li[data-count-id="${id}"]`)?.remove();
        if (!recentCountsList.children.length) {
            recentCountsList.innerHTML = '<li class="text-slate-400">No counts uploaded yet.</li>';
        }

        if (masterTableOpen) {
            // If deleting emptied the current page (and it wasn't page 1), fall
            // back a page rather than showing a dangling empty one.
            const targetPage = masterTablePage > 1 && masterTableBody.children.length === 1
                ? masterTablePage - 1
                : masterTablePage;
            await loadMasterTablePage(targetPage);
        }
    } catch (error) {
        showUploadError(error.message);
    }
}

function addRecentCountRow(id, label, status) {
    const empty = recentCountsList.querySelector('li:only-child');
    if (empty && !empty.querySelector('button')) empty.remove();
    recentCountsList.insertAdjacentHTML('afterbegin', recentCountRowHtml(id, label, status));
    while (recentCountsList.children.length > RECENT_COUNTS_LIMIT) {
        recentCountsList.lastElementChild.remove();
    }
}

function updateRecentCountRowStatus(id, status) {
    const row = recentCountsList.querySelector(`.recent-count-row[data-count-id="${id}"]`);
    if (!row) return;
    const badge = row.querySelector('span:last-child');
    badge.textContent = status;
    badge.className = badgeClass(status);
}

/* -------------------------------------------------------------------- master table */

const masterTableToggle = document.getElementById('master-table-toggle');
const counterView = document.getElementById('counter-view');
const masterTableView = document.getElementById('master-table-view');
const masterTableBody = document.getElementById('master-table-body');
const masterTablePageLabel = document.getElementById('master-table-page-label');
const masterTableEmpty = document.getElementById('master-table-empty');
const masterTablePages = document.getElementById('master-table-pages');

let masterTableOpen = false;
let masterTablePage = 1;
let masterTableLastPage = 1;

masterTableToggle?.addEventListener('click', () => {
    masterTableOpen = !masterTableOpen;
    counterView.classList.toggle('hidden', masterTableOpen);
    masterTableView.classList.toggle('hidden', !masterTableOpen);
    masterTableToggle.textContent = masterTableOpen ? 'Back to counter' : 'View master table';
    if (masterTableOpen) loadMasterTablePage(masterTablePage).catch((error) => showUploadError(error.message));
});

function fmtDate(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

/** Resolves corridor/street ids to their display names (corridor lookup is local; street needs its config, cached by fetchCorridor). */
async function masterTableRowHtml(item) {
    const corridorName = corridorsById.get(item.corridor_config)?.name ?? item.corridor_config;
    let streetName = item.street;
    try {
        const config = await fetchCorridor(item.corridor_config);
        streetName = streetsOf(config).find((s) => s.id === item.street)?.name ?? item.street;
    } catch {
        // Unknown/removed corridor config - fall back to the raw street id.
    }

    const eyeIcon = `
        <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
            <path fill-rule="evenodd" clip-rule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.147.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" />
        </svg>`;
    const trashIcon = `
        <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" />
        </svg>`;

    return `
        <tr data-count-id="${item.id}" class="divide-x divide-slate-200 dark:divide-slate-800">
            <td class="max-w-[200px] truncate px-2 py-2">${item.label ?? `Count #${item.id}`}</td>
            <td class="px-2 py-2">${corridorName}</td>
            <td class="px-2 py-2">${streetName}</td>
            <td class="px-2 py-2"><span class="${badgeClass(item.status)}">${item.status}</span></td>
            <td class="whitespace-nowrap px-2 py-2">${fmtDate(item.created_at)}</td>
            <td class="px-2 py-2 text-right tabular-nums">${item.observation_duration_seconds ?? '—'}</td>
            <td class="px-2 py-2 text-right tabular-nums">${item.vehicles_detected ?? '—'}</td>
            <td class="px-2 py-2 text-right tabular-nums">${item.total_vehicles ?? '—'}</td>
            <td class="px-2 py-2 text-right tabular-nums">${item.cars_count ?? '—'}</td>
            <td class="px-2 py-2 text-right tabular-nums">${item.trucks_count ?? '—'}</td>
            <td class="px-2 py-2 text-right tabular-nums">${item.unclassified_count ?? '—'}</td>
            <td class="px-2 py-2 text-right tabular-nums">${fmt(item.mean_flow)}</td>
            <td class="px-2 py-2 text-right tabular-nums">${fmt(item.peak_5min_flow)}</td>
            <td class="px-2 py-2 text-right tabular-nums">${fmt(item.fitted_r_squared, 3)}</td>
            <td class="px-2 py-2">${item.annotated_video_path ? '<span class="text-emerald-600 dark:text-emerald-400">Yes</span>' : '—'}</td>
            <td class="px-2 py-2">
                <div class="flex justify-end gap-1.5">
                    ${
                        item.status === 'done'
                            ? `<button type="button" data-master-view-id="${item.id}" title="View results" class="master-view-row rounded bg-sky-600 p-1 text-white hover:bg-sky-500 dark:bg-sky-500 dark:hover:bg-sky-400">${eyeIcon}</button>`
                            : ''
                    }
                    <button type="button" data-delete-count-id="${item.id}" title="Delete count" class="delete-count-row rounded bg-red-600 p-1 text-white hover:bg-red-500 dark:bg-red-500 dark:hover:bg-red-400">${trashIcon}</button>
                </div>
            </td>
        </tr>`;
}

async function loadMasterTablePage(page) {
    const url = new URL(data.listUrl, window.location.origin);
    url.searchParams.set('page', page);
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Failed to load counts (HTTP ${response.status}).`);
    const body = await response.json();

    masterTablePage = body.current_page;
    masterTableLastPage = Math.max(body.last_page, 1);

    masterTableEmpty.classList.toggle('hidden', body.data.length > 0);
    masterTableBody.innerHTML = (await Promise.all(body.data.map(masterTableRowHtml))).join('');
    masterTablePageLabel.textContent = `Page ${masterTablePage} of ${masterTableLastPage}`;
    renderMasterTablePages();
}

/** Page numbers to show around the current page: first, last, and a window of 3 centred on current. */
function pageNumbersAround(current, last) {
    const pages = new Set([1, last, current - 1, current, current + 1]);
    return [...pages].filter((n) => n >= 1 && n <= last).sort((a, b) => a - b);
}

function renderMasterTablePages() {
    let previous = 0;
    masterTablePages.innerHTML = pageNumbersAround(masterTablePage, masterTableLastPage)
        .map((n) => {
            const gap = n - previous > 1 ? '<span class="px-1 text-slate-400">…</span>' : '';
            previous = n;
            const active = n === masterTablePage;
            return `${gap}<button type="button" data-page="${n}"
                class="master-table-page-button rounded px-2 py-1 ${
                    active
                        ? 'bg-sky-600 font-semibold text-white dark:bg-sky-500'
                        : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/60'
                }">${n}</button>`;
        })
        .join('');
}

masterTablePages?.addEventListener('click', (event) => {
    const button = event.target.closest('.master-table-page-button');
    if (!button) return;
    const page = Number(button.dataset.page);
    if (page !== masterTablePage) loadMasterTablePage(page).catch((error) => showUploadError(error.message));
});

masterTableBody?.addEventListener('click', (event) => {
    const deleteButton = event.target.closest('.delete-count-row');
    if (deleteButton) {
        deleteCount(Number(deleteButton.dataset.deleteCountId));
        return;
    }

    const viewButton = event.target.closest('.master-view-row');
    if (viewButton) {
        const id = Number(viewButton.dataset.masterViewId);
        masterTableToggle.click();
        loadCount(id).catch((error) => {
            resultsEmpty.classList.remove('hidden');
            resultsEmpty.textContent = error.message;
        });
    }
});
