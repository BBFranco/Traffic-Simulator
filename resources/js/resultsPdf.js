/**
 * "Export PDF" report for /results - lazy-loaded by results.js so jsPDF stays out of the
 * page's main bundle.
 *
 * Unlike the on-screen dashboard, which shows ONE scope and ONE adaptive comparison target
 * at a time, the report spells out every combination the payload already carries, in fixed
 * sections (SECTION): a headline, 1 Total blackout and 2 Rolling blackout (each scope beside the
 * normal-power baseline - Total / Main arterial / Side streets, plus the three zones under the
 * rolling blackout), 3 Coordination and 4 Method notes - with every controller variant side by
 * side: fixed-time, the blended adaptive average, each adaptive sensor on its own, and green wave.
 * Nothing is recomputed here except the blended adaptive recovery curve (same point-wise
 * average results.js draws); the paired deltas come straight from
 * ResultsController::pairedComparisons().
 *
 * Charts are drawn offscreen with the same Chart.js theme as the page, forced to light ink
 * for print, and embedded as PNGs.
 */

import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import {
    Chart,
    INK,
    MODE_COLOURS,
    POWER_LABELS,
    SENSOR_LABELS,
    applyChartTheme,
    baseOptions,
    barDataset,
    barValueLabels,
    lineDataset,
    xRangeBand,
} from './charts/theme.js';
import { currentTheme } from './theme.js';
import { buildLayout, corridorCounts } from './sim/corridor.js';
import { MAX_WARMUP_TICKS, PROBE_REPLICATIONS, WARMUP_SAFETY_MARGIN } from './sim/warmupProbe.js';
import { ADAPTIVE_DEFAULTS, COORDINATED_DEFAULTS } from './sim/equations.js';
import { SENSOR_SPEC_SETS, latencyTicks } from './sim/sensorSpecs.js';
import { seedForRep } from './sim/experimentalMatrix.js';
import { LayoutRenderer, ZONE_TINTS, setRendererTheme } from './sim/renderer.js';

/** Zone wait is charged by junction (zoneAccounting by-junction-v1), so every zone caption says what that pulls in. */
const zoneDescription = (zone) =>
    `Wait charged to the zone ${zone} junction each car queued for - so it includes Jan Shoba and other vertical-road queues at zone ${zone}'s junctions`;

const SCOPES = [
    { key: 'total', suffix: '', label: 'Total', description: 'Main arterial + side streets combined' },
    { key: 'arterial', suffix: '_arterial', label: 'Main arterial', description: 'Traffic on the main arterial only' },
    { key: 'side_street', suffix: '_side_street', label: 'Side streets', description: 'Traffic on the cross streets only' },
    { key: 'zone1', suffix: '_zone1', zone: 1, label: 'Zone 1 (south)', description: zoneDescription(1) },
    { key: 'zone2', suffix: '_zone2', zone: 2, label: 'Zone 2 (middle)', description: zoneDescription(2) },
    { key: 'zone3', suffix: '_zone3', zone: 3, label: 'Zone 3 (north)', description: zoneDescription(3) },
];
/** The by-road scopes - every power state has them; the zone scopes are the rolling blackout's own. */
const ROAD_SCOPES = SCOPES.filter((scope) => !scope.zone);

/**
 * The two outage sections. `segments` are the segmented table's columns (suffixes on avg_wait_time_ / throughput_per_min_):
 * rolling splits the dark time into its two stages. Pre and post are the same columns in both - post is after the FINAL restore.
 */
const OUTAGES = {
    load_shedding: {
        title: 'Total blackout',
        subtitle: 'Every junction dark at once, then all restored together - each variant against fixed-time at normal power and in the blackout',
        scopes: ROAD_SCOPES,
        segments: [
            { key: 'pre_outage', label: 'Pre-outage' },
            { key: 'during_outage', label: 'During' },
            { key: 'post_recovery', label: 'Post-recovery' },
        ],
    },
    rolling_blackout: {
        title: 'Load shedding',
        subtitle: 'Zones go dark in turn (zones 1 + 3, then zone 2) - by road and by zone, against fixed-time at normal power and under load shedding',
        scopes: SCOPES,
        segments: [
            { key: 'pre_outage', label: 'Pre-outage' },
            { key: 'stage1', label: 'Stage 1' },
            { key: 'stage2', label: 'Stage 2' },
            { key: 'post_recovery', label: 'Post (all lit)' },
        ],
    },
};

/** Fixed section numbers - every cross-reference in the text reads from here, never a literal. */
const SECTION = { load_shedding: 1, rolling_blackout: 2, coordination: 3, methodNotes: 4 };
const POWER_ORDER = ['normal', 'load_shedding', 'rolling_blackout'];

/** An outage section's subsections in order: one per scope, then these three. */
const OUTAGE_TAIL_PARTS = ['distribution', 'routing', 'roadWaits'];

/** "2.4" - the number a part of an outage section is printed under (a scope key or one of OUTAGE_TAIL_PARTS). */
function partRef(power, part) {
    const parts = [...OUTAGES[power].scopes.map((scope) => scope.key), ...OUTAGE_TAIL_PARTS];
    return `${SECTION[power]}.${parts.indexOf(part) + 1}`;
}

/** Vertical roads carry no zone - their queues go to the zone of the junction they queue at. */
const VERTICAL_ROADS = 'Jan Shoba, Hilda, Festival, Grosvenor, Dyer, Herold';

const SENSOR_ORDER = ['inductive_loop', 'radar', 'camera', 'magnetometer'];

// Each actuated mode keeps its own family so every sensor still reads as that mode next to the
// orange fixed-time baseline and green-wave's green: adaptive violet, coordinated adaptive rose.
// Validated (dataviz validate_palette.js) in report order: all 12 bars pass.
const SENSOR_COLOURS = {
    adaptive: {
        inductive_loop: '#5b21b6',
        radar: '#a78bfa',
        camera: '#c026d3',
        magnetometer: '#6366f1',
    },
    coordinated_adaptive: {
        inductive_loop: '#9d174d',
        radar: '#f472b6',
        camera: '#be123c',
        magnetometer: '#fb7185',
    },
};
const SENSOR_MODE_LABELS = { adaptive: 'Adaptive', coordinated_adaptive: 'Coordinated adaptive' };

/** Road-wait rows where every controller's mean stays under this (s) are hidden: slips and on/off ramps at ~0 s carry only noise. */
const ROAD_WAIT_MIN_S = 0.5;

const PAGE = { width: 210, height: 297, margin: 14 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;
const TOP = 22;
const BOTTOM = PAGE.height - 16;

const COLOURS = {
    ink: [15, 23, 42],
    secondary: [71, 85, 105],
    muted: [100, 116, 139],
    rule: [226, 232, 240],
    band: [15, 23, 42],
    accent: [2, 132, 199],
    headFill: [241, 245, 249],
    better: [220, 252, 231],
    betterText: [4, 120, 87],
    worse: [255, 228, 230],
    worseText: [190, 18, 60],
};

const one = (v) => (v === null || v === undefined ? null : Number(Number(v).toFixed(1)));
const fmt = (v, suffix = '') => (v === null || v === undefined ? 'n/a' : `${Number(v).toFixed(1)}${suffix}`);
const fmtCi = (v, ci) => (v === null || v === undefined ? 'n/a' : `${Number(v).toFixed(1)}${ci == null ? '' : ` ± ${Number(ci).toFixed(1)}`}`);
const fmtDelta = (v, suffix) => (v === null || v === undefined ? 'n/a' : `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}${suffix}`);
/** Recovery mean + how many runs it's built on - avg() skips runs that never recovered. */
const fmtRecovery = (row, metric) => {
    const recovered = `${row[`${metric}_recovered`]}/${row.runs}`;
    return row[metric] == null ? `did not recover (${recovered})` : `${Number(row[metric]).toFixed(1)} s (${recovered})`;
};
/**
 * Mean recovery time with every run that never recovered counted at the full window after
 * power returns - a floor on the true mean (it understates the gap), but one figure built on
 * every run rather than on the few that made it.
 */
const cappedRecoveryS = (meanS, recovered, runs, windowS) =>
    windowS == null || !runs ? null : ((meanS ?? 0) * recovered + windowS * (runs - recovered)) / runs;
/** The capped-mean wait recovery must differ from the baseline's by this share before its cell is tinted - the capped mean carries no interval. */
const CAPPED_GAP_MIN = 0.1;
/** Wait recovery as the share of runs that recovered within the window, then the capped mean. */
const fmtWaitRecovery = (row, metric, windowS) => {
    const recovered = row[`${metric}_recovered`];
    const capped = cappedRecoveryS(row[metric], recovered, row.runs, windowS);
    return `${Math.round((recovered / row.runs) * 100)}% recovered (${recovered}/${row.runs})${capped == null ? '' : `
capped mean ${Math.round(capped)} s`}`;
};

const powerLabel = (power) => POWER_LABELS[power] ?? power;
const isOutage = (power) => power !== 'normal';
const minute = (seconds) => Math.round(seconds / 60);

/**
 * A scope's post-restore window under `power` - also its wait-recovery cap: 60 min for the total blackout and rolling
 * zones 1/3, 45 min for rolling zone 2 and the by-road scopes. Falls back to the scalar total-blackout window for old stamps.
 */
function postRestoreWindowS(data, power, scope) {
    const stamp = data.batchStamp;
    return stamp?.postRestoreWindowSByScope?.[power]?.[scope.key] ?? (power === 'load_shedding' ? stamp?.postRestoreWindowS ?? null : null);
}

/** The measured second a scope's recovery is timed from: the final restore for the by-road scopes, each zone's own restore. */
function restoreSeconds(data, power, scope) {
    const fromStamp = data.batchStamp?.restoreSecondsByScope?.[power]?.[scope.key];
    if (fromStamp != null) return fromStamp;
    if (power !== 'load_shedding' || data.batchStamp?.outageEndMinutes == null) return null;
    return data.batchStamp.outageEndMinutes * 60;
}

/** The zones still dark at `atS` under the rolling schedule - what a zone 1/3 recovery is measured next to. */
function zonesDarkAt(data, atS) {
    return (data.batchStamp?.rollingSchedule ?? []).filter((w) => w.fromS <= atS && w.toS > atS).flatMap((w) => w.zones ?? []);
}

/**
 * Where a scope's recovery is timed from and where it is capped, plus - for a zone that restores while another is still
 * dark - why its figure can't be read against the total blackout. Said where the numbers are, not only in the method notes.
 */
function recoveryBasis(data, power, scope) {
    const restoreS = restoreSeconds(data, power, scope);
    const windowS = postRestoreWindowS(data, power, scope);
    const at = restoreS == null ? '' : ` at minute ${minute(restoreS)}`;
    const cap = windowS == null ? '' : `; wait recovery capped at ${minute(windowS)} min`;
    if (power !== 'rolling_blackout') return `Recovery is timed from the restore${at}${cap}.`;
    if (!scope.zone) return `Recovery is timed from the final restore${at}, when the last zone comes back${cap}.`;

    const finalS = restoreSeconds(data, power, SCOPES[0]);
    const basis = `Zone ${scope.zone} recovery is timed from its own restore${at}${cap}.`;
    if (restoreS == null || finalS == null || restoreS >= finalS) return basis;
    const dark = zonesDarkAt(data, restoreS).filter((zone) => zone !== scope.zone);
    const neighbour = dark.length ? `zone ${dark.join(' + ')} is` : 'another zone is';
    return `${basis} It is measured while ${neighbour} still dark, so it includes spillback from ${dark.length ? `zone ${dark.join(' + ')}` : 'it'} and is NOT comparable to total-blackout recovery.`;
}

/** The recovery curves for `power`: its own timeline, or - in payloads from before byPowerState - the top level when it is that state's. */
function timelineFor(data, power) {
    const timeline = data.recoveryTimeline;
    if (!timeline) return null;
    if (timeline.byPowerState) return timeline.byPowerState[power] ?? null;
    return (timeline.powerState ?? 'load_shedding') === power ? timeline : null;
}

/** Same wording as the Results page's bands (results.js darkWindowLabel()). */
function darkWindowLabel(zones) {
    if (!zones?.length) return 'ALL ZONES DARK';
    return `${zones.length > 1 ? 'ZONES' : 'ZONE'} ${zones.join(' + ')} DARK`;
}

/** A timeline's dark windows - a legacy curve without them gets one from sheddingStart/End. */
function darkWindows(timeline) {
    if (timeline.darkWindows?.length) return timeline.darkWindows;
    return timeline.sheddingStart != null && timeline.sheddingEnd != null ? [{ zones: null, fromS: timeline.sheddingStart, toS: timeline.sheddingEnd }] : [];
}

/**
 * Every controller variant the report compares, in a fixed order - baseline first. `row(power)`
 * resolves the aggregate row, `seriesKeys(timeline)` the recovery-timeline curves behind it (several
 * for the blended adaptive average, which has no single stored curve).
 */
function buildVariants(data) {
    const byKey = new Map(data.aggregates.map((row) => [`${row.controller_mode}|${row.power_state}`, row]));
    const bySensor = new Map(
        data.aggregatesBySensor
            .filter((row) => SENSOR_COLOURS[row.controller_mode] && row.sensor_mode)
            .map((row) => [`${row.controller_mode}|${row.sensor_mode}|${row.power_state}`, row])
    );

    /** An actuated mode's blended average, then one variant per sensor it was run with. */
    const sensorFamily = (mode) => {
        const label = SENSOR_MODE_LABELS[mode];
        const sensors = SENSOR_ORDER.filter((sensor) => data.powerStates.some((power) => bySensor.has(`${mode}|${sensor}|${power}`)));
        return [
            {
                id: `${mode}|average`,
                mode,
                sensor: 'average',
                label: `${label} (avg. of sensors)`,
                colour: MODE_COLOURS[mode],
                row: (p) => byKey.get(`${mode}|${p}`),
                seriesKeys: (timeline) => Object.keys(timeline.series ?? {}).filter((key) => key.startsWith(`${mode}|`)),
            },
            ...sensors.map((sensor) => ({
                id: `${mode}|${sensor}`,
                mode,
                sensor,
                label: `${label} - ${SENSOR_LABELS[sensor] ?? sensor}`,
                colour: SENSOR_COLOURS[mode][sensor] ?? MODE_COLOURS[mode],
                row: (p) => bySensor.get(`${mode}|${sensor}|${p}`),
                seriesKeys: () => [`${mode}|${sensor}`],
            })),
        ];
    };

    const variants = [
        { id: 'fixed|', mode: 'fixed', sensor: null, label: 'Fixed-time', colour: MODE_COLOURS.fixed, row: (p) => byKey.get(`fixed|${p}`), seriesKeys: () => ['fixed|'] },
        ...sensorFamily('adaptive'),
        { id: 'green_wave|', mode: 'green_wave', sensor: null, label: 'Green wave', colour: MODE_COLOURS.green_wave, row: (p) => byKey.get(`green_wave|${p}`), seriesKeys: () => ['green_wave|'] },
        ...sensorFamily('coordinated_adaptive'),
    ];

    return variants.filter((variant) => data.powerStates.some((power) => variant.row(power)));
}

/* ------------------------------------------------------------- offscreen charts */

/** Renders a Chart.js config onto a detached canvas and returns it as a PNG data URL. */
function renderChartImage(config, widthPx, heightPx) {
    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthPx}px;height:${heightPx}px;`;
    const canvas = document.createElement('canvas');
    canvas.style.width = `${widthPx}px`;
    canvas.style.height = `${heightPx}px`;
    canvas.width = widthPx;
    canvas.height = heightPx;
    host.appendChild(canvas);
    document.body.appendChild(host);

    // White backdrop - a PNG with a transparent background prints grey in some viewers.
    const whiteBackground = {
        id: 'whiteBackground',
        beforeDraw(chart) {
            const { ctx } = chart;
            ctx.save();
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, chart.width, chart.height);
            ctx.restore();
        },
    };

    const chart = new Chart(canvas, {
        ...config,
        options: { ...config.options, responsive: false, animation: false, devicePixelRatio: 2 },
        plugins: [whiteBackground, ...(config.plugins ?? [])],
    });
    const image = chart.toBase64Image('image/png');
    chart.destroy();
    host.remove();

    return image;
}

/**
 * The selected corridor's road layout, drawn by the simulator's own LayoutRenderer from the
 * same config the batch runs against - so any corridor, including one added later, shows up
 * as it really is. Canvas height follows the layout's own aspect (within limits) so a long
 * straight corridor doesn't render as a thin strip. A layout with rolling-blackout zones is drawn
 * as the zone figure: horizontal roads tinted by zone (ZONE_TINTS), vertical roads plain. Null
 * when it can't be drawn.
 */
async function corridorLayoutImage(corridorUrl) {
    const response = await fetch(corridorUrl, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const layout = buildLayout(await response.json());
    const zoned = [...layout.arterials, ...layout.connectors].some((road) => road.zone != null);

    const widthPx = 1100;
    const aspect = Math.min(0.6, Math.max(0.32, layout.bounds.heightM / Math.max(layout.bounds.widthM, 1)));
    const heightPx = Math.round(widthPx * aspect);

    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthPx}px;height:${heightPx}px;`;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block;';
    host.appendChild(canvas);
    document.body.appendChild(host);

    try {
        setRendererTheme('light');
        const renderer = new LayoutRenderer(canvas, { pixelRatio: 2 });
        if (zoned) renderer.setOptions({ zoneTint: ZONE_TINTS });
        renderer.setLayout(layout);
        return {
            image: canvas.toDataURL('image/png'),
            aspect,
            zoned,
            ...corridorCounts(layout),
        };
    } finally {
        setRendererTheme(currentTheme());
        host.remove();
    }
}

const printLegend = {
    display: true,
    position: 'bottom',
    labels: { boxWidth: 10, boxHeight: 10, padding: 10, color: '#0f172a', font: { size: 10 } },
};

/** One bar group per power state in `powers` (a section's normal baseline and its own outage), one bar per variant. */
function barChartImage(variants, metric, powers, { unit, tickSuffix = '' }) {
    const options = baseOptions({ tickFormat: (v) => `${v}${tickSuffix}` });

    return renderChartImage(
        {
            type: 'bar',
            data: {
                labels: powers.map(powerLabel),
                datasets: variants.map((variant) =>
                    barDataset({
                        label: variant.label,
                        colour: variant.colour,
                        data: powers.map((power) => one(variant.row(power)?.[metric] ?? null)),
                    })
                ),
            },
            options: {
                ...options,
                plugins: { ...options.plugins, legend: printLegend, tooltip: { enabled: false }, barValueLabels: { formatter: (v) => `${v}${unit}` } },
            },
            plugins: [barValueLabels],
        },
        760,
        270
    );
}

/** A variant's recovery curve for `metricKey` - the blended adaptive average is a point-wise mean. */
function recoverySeries(timeline, variant, metricKey) {
    const curves = variant.seriesKeys(timeline).map((key) => timeline.series[key]?.[metricKey]).filter(Boolean);
    if (!curves.length) return null;
    if (curves.length === 1) return curves[0];

    return curves[0].map((_, i) => {
        const values = curves.map((curve) => curve[i]).filter((v) => v !== null && v !== undefined);
        return values.length ? one(values.reduce((sum, v) => sum + v, 0) / values.length) : null;
    });
}

function nearestIndex(seconds, target) {
    let best = 0;
    seconds.forEach((s, i) => {
        if (Math.abs(s - target) < Math.abs(seconds[best] - target)) best = i;
    });
    return best;
}

/**
 * A strip in the zone's colour along the top of each dark band (split where a band darkens several zones), under the
 * band's own label - the colour sits on the mark, the label stays in band ink. An all-zones band gets no strip.
 */
const zoneBandStrips = {
    id: 'zoneBandStrips',
    afterDatasetsDraw(chart, _args, opts) {
        const { ctx, chartArea, scales } = chart;
        for (const band of opts?.bands ?? []) {
            const zones = (band.zones ?? []).filter((zone) => ZONE_TINTS[zone]);
            if (!zones.length) continue;
            const x0 = scales.x.getPixelForValue(band.from);
            const x1 = scales.x.getPixelForValue(band.to);
            const step = (x1 - x0) / zones.length;
            ctx.save();
            zones.forEach((zone, i) => {
                ctx.fillStyle = ZONE_TINTS[zone];
                ctx.fillRect(x0 + i * step, chartArea.top - 4, step, 3);
            });
            ctx.restore();
        }
    },
};

/** `power`'s recovery curves, one per variant, with a shaded band per dark window (labelled by the zones it darkens). */
function recoveryLineImage(data, variants, metricKey, power) {
    const timeline = timelineFor(data, power);
    if (!timeline?.seconds?.length) return null;

    const datasets = variants
        .map((variant) => ({ variant, series: recoverySeries(timeline, variant, metricKey) }))
        .filter(({ series }) => series)
        .map(({ variant, series }) => ({ ...lineDataset({ label: variant.label, colour: variant.colour, data: series }), borderWidth: 1.6 }));
    if (!datasets.length) return null;

    const options = baseOptions({ xTitle: 'seconds into run' });
    const bands = darkWindows(timeline).map((w) => ({
        from: nearestIndex(timeline.seconds, w.fromS),
        to: nearestIndex(timeline.seconds, w.toS),
        label: darkWindowLabel(w.zones),
        zones: w.zones,
    }));

    return renderChartImage(
        {
            type: 'line',
            data: { labels: timeline.seconds, datasets },
            options: {
                ...options,
                plugins: {
                    ...options.plugins,
                    legend: printLegend,
                    tooltip: { enabled: false },
                    xRangeBand: { bands },
                    zoneBandStrips: { bands },
                },
            },
            plugins: [xRangeBand, zoneBandStrips],
        },
        760,
        300
    );
}

/** Horizontal time-to-recovery bars under `power`, one per variant that actually recovered in the window. */
function recoveryTimeImage(variants, metric, power) {
    const measured = variants.filter((variant) => variant.row(power)?.[metric] != null);
    if (!measured.length) return null;

    const options = baseOptions();
    options.layout.padding = { top: 6, right: 44, bottom: 2, left: 2 };
    options.scales = {
        x: { beginAtZero: true, grid: { color: INK.grid, drawTicks: false }, border: { display: false }, ticks: { color: INK.secondary, callback: (v) => `${v}s` } },
        y: { grid: { display: false }, border: { color: INK.axis }, ticks: { color: INK.primary } },
    };

    const valueLabels = {
        id: 'hBarValueLabels',
        afterDatasetsDraw(chart) {
            const { ctx } = chart;
            ctx.save();
            ctx.font = '600 10px Figtree, ui-sans-serif, system-ui, sans-serif';
            ctx.fillStyle = INK.secondary;
            ctx.textBaseline = 'middle';
            chart.getDatasetMeta(0).data.forEach((bar, i) => ctx.fillText(`${chart.data.datasets[0].data[i]}s`, bar.x + 6, bar.y));
            ctx.restore();
        },
    };

    return renderChartImage(
        {
            type: 'bar',
            data: {
                labels: measured.map((variant) => {
                    const row = variant.row(power);
                    return [variant.label, `${row[`${metric}_recovered`]}/${row.runs} recovered`];
                }),
                datasets: [
                    {
                        data: measured.map((variant) => one(variant.row(power)[metric])),
                        backgroundColor: measured.map((variant) => variant.colour),
                        borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 4, bottomRight: 4 },
                        borderSkipped: 'left',
                        categoryPercentage: 0.7,
                        barPercentage: 0.86,
                        maxBarThickness: 26,
                    },
                ],
            },
            options: { ...options, indexAxis: 'y', plugins: { ...options.plugins, tooltip: { enabled: false } } },
            plugins: [valueLabels],
        },
        380,
        60 + measured.length * 38
    );
}

/* ---------------------------------------------------------------- page layout */

class Report {
    constructor(meta) {
        this.doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
        this.meta = meta;
        this.y = TOP;
        // Outline numbering: section (3) > heading (3.1) > chart card (3.1.1). Null section = unnumbered (cover, appendix).
        this.section = null;
        this.sub = 0;
        this.card = 0;
    }

    /** Numbers a heading (3.1) or chart title (3.1.1) under the current section; unchanged outside a numbered section. */
    numbered(title, level) {
        if (this.section == null) return title;
        if (level === 'sub') {
            this.sub += 1;
            this.card = 0;
            return `${this.section}.${this.sub}  ${title}`;
        }
        if (!this.sub) return title;
        this.card += 1;
        return `${this.section}.${this.sub}.${this.card}  ${title}`;
    }

    newPage() {
        this.doc.addPage();
        this.y = TOP;
    }

    ensureSpace(height) {
        if (this.y + height > BOTTOM) this.newPage();
    }

    sectionTitle(title, subtitle, number = null) {
        this.section = number;
        this.sub = 0;
        this.card = 0;
        if (number != null) title = `${number}. ${title}`;
        this.ensureSpace(22);
        const { doc } = this;
        doc.setFillColor(...COLOURS.accent);
        doc.rect(PAGE.margin, this.y, 1.4, subtitle ? 11 : 7, 'F');
        doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(...COLOURS.ink);
        doc.text(title, PAGE.margin + 4, this.y + 5);
        if (subtitle) {
            doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...COLOURS.muted);
            doc.text(subtitle, PAGE.margin + 4, this.y + 10.5);
        }
        this.y += subtitle ? 17 : 12;
    }

    /**
     * A heading (3.1) - or, with `level: 'card'`, one numbered like a chart card (3.1.2) inside a subsection. `swatch`
     * draws a colour mark before the title (a zone's tint); the title itself stays in text ink.
     */
    heading(title, caption, { level = 'sub', swatch = null } = {}) {
        title = this.numbered(title, level);
        const { doc } = this;
        const captionLines = caption ? doc.setFontSize(8).splitTextToSize(caption, CONTENT_WIDTH) : [];
        this.ensureSpace(10 + captionLines.length * 3.6 + 20);
        let x = PAGE.margin;
        if (swatch) {
            doc.setFillColor(swatch);
            doc.roundedRect(x, this.y + 1.2, 3.2, 3.2, 0.6, 0.6, 'F');
            x += 5;
        }
        doc.setFont('helvetica', 'bold').setFontSize(level === 'sub' ? 11 : 10).setTextColor(...COLOURS.ink);
        doc.text(title, x, this.y + 4);
        this.y += 6;
        if (captionLines.length) {
            doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...COLOURS.muted);
            doc.text(captionLines, PAGE.margin, this.y + 3);
            this.y += captionLines.length * 3.6 + 1.5;
        }
        this.y += 1.5;
    }

    paragraph(text) {
        const { doc } = this;
        const lines = doc.setFont('helvetica', 'normal').setFontSize(9).splitTextToSize(text, CONTENT_WIDTH);
        this.ensureSpace(lines.length * 4.2 + 3);
        doc.setTextColor(...COLOURS.secondary);
        doc.text(lines, PAGE.margin, this.y + 3.5);
        this.y += lines.length * 4.2 + 3;
    }

    image(dataUrl, widthMm, heightMm, x = PAGE.margin) {
        this.ensureSpace(heightMm + 4);
        this.doc.addImage(dataUrl, 'PNG', x, this.y, widthMm, heightMm, undefined, 'FAST');
        this.y += heightMm + 4;
    }

    /** A bordered chart card: title + unit line, then the chart image. */
    chartCard(title, caption, dataUrl, aspect) {
        title = this.numbered(title, 'card');
        const imageHeight = CONTENT_WIDTH * aspect;
        this.ensureSpace(imageHeight + 16);
        const { doc } = this;
        const top = this.y;
        doc.setDrawColor(...COLOURS.rule).setLineWidth(0.3);
        doc.roundedRect(PAGE.margin, top, CONTENT_WIDTH, imageHeight + 13, 2, 2, 'S');
        doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...COLOURS.ink);
        doc.text(title, PAGE.margin + 3, top + 5.5);
        doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...COLOURS.muted);
        doc.text(caption, PAGE.margin + 3, top + 9.5);
        doc.addImage(dataUrl, 'PNG', PAGE.margin + 2, top + 11, CONTENT_WIDTH - 4, imageHeight - 1, undefined, 'FAST');
        this.y = top + imageHeight + 17;
    }

    table(options) {
        this.ensureSpace(24);
        autoTable(this.doc, {
            startY: this.y,
            margin: { left: PAGE.margin, right: PAGE.margin, top: TOP, bottom: PAGE.height - BOTTOM },
            theme: 'grid',
            styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.6, textColor: COLOURS.ink, lineColor: COLOURS.rule, lineWidth: 0.2 },
            headStyles: { fillColor: COLOURS.headFill, textColor: COLOURS.secondary, fontStyle: 'bold', fontSize: 7 },
            alternateRowStyles: { fillColor: [250, 251, 253] },
            ...options,
        });
        this.y = this.doc.lastAutoTable.finalY + 7;
    }

    /** Running header + page footer on every page except the cover. */
    stampPages() {
        const { doc, meta } = this;
        const total = doc.getNumberOfPages();
        for (let page = 1; page <= total; page += 1) {
            doc.setPage(page);
            doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...COLOURS.muted);
            if (page > 1) {
                doc.text(`Traffic Simulator · Results report · ${meta.corridorName}`, PAGE.margin, 12);
                doc.text(meta.generatedAt, PAGE.width - PAGE.margin, 12, { align: 'right' });
                doc.setDrawColor(...COLOURS.rule).setLineWidth(0.3);
                doc.line(PAGE.margin, 14.5, PAGE.width - PAGE.margin, 14.5);
            }
            doc.text(`Page ${page} of ${total}`, PAGE.width - PAGE.margin, PAGE.height - 8, { align: 'right' });
        }
    }
}

/* ------------------------------------------------------------------- sections */

function drawCover(report, data, variants, corridorLayout) {
    const { doc, meta } = report;

    doc.setFillColor(...COLOURS.band);
    doc.rect(0, 0, PAGE.width, 62, 'F');
    doc.setFillColor(...COLOURS.accent);
    doc.rect(0, 62, PAGE.width, 1.5, 'F');

    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(148, 163, 184);
    doc.text('TRAFFIC SIMULATOR · RESULTS REPORT', PAGE.margin, 20);
    doc.setFont('helvetica', 'bold').setFontSize(24).setTextColor(255, 255, 255);
    doc.text(doc.splitTextToSize(meta.corridorName, CONTENT_WIDTH), PAGE.margin, 33);
    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(203, 213, 225);
    doc.text('Does ITS beat the fixed-time baseline? Every scope, every controller variant.', PAGE.margin, 50);
    const routing = data.batchStamp?.routingMode === 'destination' ? 'Destination routing' : 'Random turning';
    doc.text(`Generated ${meta.generatedAt} · Vehicle routing: ${routing}`, PAGE.margin, 56);


    // Every power state's runs, the rolling blackout's included; conditions are the per-sensor rows of all three states.
    const totalRuns = data.aggregates.reduce((sum, row) => sum + row.runs, 0);
    const conditions = data.aggregatesBySensor.length;
    const runsByPower = data.powerStates
        .map((power) => [power, data.aggregates.filter((row) => row.power_state === power).reduce((sum, row) => sum + row.runs, 0)])
        .filter(([, runs]) => runs);
    const stats = [
        ['Batch runs', totalRuns.toLocaleString(), 1],
        ['Conditions', String(conditions), 1],
        ['Reps / condition', conditions ? String(Math.round(totalRuns / conditions)) : 'n/a', 1],
        ['Outage window', outageWindowCard(data), 1.9],
        ['Warm-up', data.batchWarmupLabel ?? 'n/a', 1],
    ];

    if (data.batchStamp?.label) {
        doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(...COLOURS.muted);
        doc.text(doc.splitTextToSize(`Batch: ${data.batchStamp.label}`, CONTENT_WIDTH).slice(0, 2), PAGE.margin, 67.5);
    }

    const unit = (CONTENT_WIDTH - (stats.length - 1) * 4) / stats.reduce((sum, [, , weight]) => sum + weight, 0);
    let x = PAGE.margin;
    stats.forEach(([label, value, weight]) => {
        const boxWidth = unit * weight;
        doc.setFillColor(...COLOURS.headFill).setDrawColor(...COLOURS.rule);
        doc.roundedRect(x, 74, boxWidth, 20, 2, 2, 'FD');
        doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(...COLOURS.muted);
        doc.text(label.toUpperCase(), x + 3, 80);
        // A two-line value (the outage card's two schedules) drops to a size that fits the card.
        const lines = value.split('\n');
        doc.setFont('helvetica', 'bold').setFontSize(lines.length > 1 ? 8.5 : 14).setTextColor(...COLOURS.ink);
        doc.text(lines, x + 3, lines.length > 1 ? 85 : 89);
        x += boxWidth + 4;
    });
    if (runsByPower.length) {
        doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...COLOURS.secondary);
        doc.text(`Runs by power state: ${runsByPower.map(([power, runs]) => `${powerLabel(power)} ${runs.toLocaleString()}`).join(' · ')}`, PAGE.margin, 99);
    }

    report.y = 104;
    if (data.lockupLabel) {
        doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(...COLOURS.worseText);
        const warning = doc.splitTextToSize(
            `Lockup in this batch: the lockup watch found a vehicle that stood still for 5 minutes or more with the whole queue ahead of it stuck too, or vehicles waiting on each other in a cycle for a minute - a simulation fault, not traffic. Locked runs: ${data.lockupLabel}.`,
            CONTENT_WIDTH
        );
        doc.text(warning, PAGE.margin, report.y);
        report.y += warning.length * 3.6 + 3;
    }
    if (data.starvedLabel) {
        doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...COLOURS.ink);
        const note = doc.splitTextToSize(
            `Starved approaches: a vehicle stood still for 5 minutes or more while the queue ahead of it still moved - an approach that couldn't get into traffic backed up past it. Saturation, not a fault; these runs are in the results. Runs: ${data.starvedLabel}.`,
            CONTENT_WIDTH
        );
        doc.text(note, PAGE.margin, report.y);
        report.y += note.length * 3.6 + 3;
    }
    if (data.hasNonStationaryBatch) {
        doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(...COLOURS.worseText);
        const warning = doc.splitTextToSize(
            'Baseline not stationary: the warm-up probe found a controller whose waits were still growing after the longest warm-up, so this batch was capped at that maximum. Its steady-state figures describe a system that is still drifting.' +
                (data.warmupDriftingLabel ? ` Still drifting: ${data.warmupDriftingLabel}.` : ''),
            CONTENT_WIDTH
        );
        doc.text(warning, PAGE.margin, report.y);
        report.y += warning.length * 3.6 + 3;
    }
    if (corridorLayout) {
        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        // "Coordinable" is not "coordinated": only the junctions on a strong link marry, so say how many did.
        const marriedAtNormal = (junctions) => junctions.filter((row) => (row.married_pct_by_power?.normal ?? row.married_pct ?? 0) >= 50).length;
        report.chartCard(
            'Corridor layout',
            [
                plural(corridorLayout.arterialRoads, 'arterial road'),
                plural(corridorLayout.sideRoads, 'side street'),
                // park_hilda is signal-controlled but has no arterial approach, so coordination never takes it: count what could coordinate.
                data.coordinationMetrics?.junctions?.length && data.coordinationMetrics.junctions.length < corridorLayout.signals
                    ? `${data.coordinationMetrics.junctions.length} coordinable of ${plural(corridorLayout.signals, 'signalised junction')} (${marriedAtNormal(data.coordinationMetrics.junctions)} married at normal power)`
                    : plural(corridorLayout.signals, 'signalised junction'),
                corridorLayout.roundabouts && plural(corridorLayout.roundabouts, 'roundabout'),
                corridorLayout.allWayStops && plural(corridorLayout.allWayStops, 'all-way stop'),
                corridorLayout.stopStreets && plural(corridorLayout.stopStreets, 'stop street'),
            ].filter(Boolean).join(' · '),
            corridorLayout.image,
            corridorLayout.aspect
        );
        if (corridorLayout.zoned) drawZoneLegend(report);
    }

    report.heading('Controller variants in this report', 'Colour follows the variant on every chart. Adaptive and coordinated adaptive are each broken out per sensor model as well as the blended average across sensors.');
    // Two columns keep the legend short enough to leave the layout on the cover.
    const rowsPerColumn = Math.ceil(variants.length / 2);
    variants.forEach((variant, i) => {
        const x = PAGE.margin + (i >= rowsPerColumn ? CONTENT_WIDTH / 2 : 0);
        const y = report.y + (i % rowsPerColumn) * 5.2;
        doc.setFillColor(variant.colour);
        doc.roundedRect(x, y - 2.6, 3.2, 3.2, 0.6, 0.6, 'F');
        doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...COLOURS.ink);
        doc.text(variant.label, x + 5.5, y);
    });
    report.y += rowsPerColumn * 5.2 + 4;

    report.heading(
        'Headline - ITS vs fixed-time (Total scope)',
        `Paired against Webster-timed fixed-time control on the same seeds and power state; ± is the 95% CI on the per-seed differences. Wait (mean, median, P95): negative is better. Throughput and cleared-without-stopping: positive is better. Every sensor on its own, and the main-arterial and side-street scopes, follow in section ${SECTION.load_shedding} (total blackout) and section ${SECTION.rolling_blackout} (load shedding, with the zone scopes in ${partRef('rolling_blackout', 'zone1')}-${partRef('rolling_blackout', 'zone3')}).`
    );
    comparisonTable(report, data, variants, SCOPES[0], { compact: true, powers: data.powerStates });
}

/**
 * The outage card: "Total 15–30 min" and "Rolling Z1+3 15–30, Z2 30–45" on two lines, built from the batch's own schedules
 * (outage minutes and rollingSchedule) - only the states the batch ran.
 */
function outageWindowCard(data) {
    const stamp = data.batchStamp;
    const lines = [];
    if (stamp?.outageStartMinutes != null && stamp?.outageEndMinutes != null) lines.push(`Total ${stamp.outageStartMinutes}–${stamp.outageEndMinutes} min`);
    if (stamp?.rollingSchedule?.length) {
        lines.push(`Load shedding ${stamp.rollingSchedule.map((w) => `Z${(w.zones ?? []).join('+')} ${minute(w.fromS)}–${minute(w.toS)}`).join(', ')}`);
    }
    if (lines.length) return lines.join('\n');

    // An unstamped batch: the recovery timeline's band, as before.
    const timeline = data.recoveryTimeline;
    return timeline?.sheddingStart != null ? `${Math.round(timeline.sheddingStart)}-${Math.round(timeline.sheddingEnd)} s` : 'n/a';
}

/** The zone figure's key: one swatch per zone in its tint, and how the untinted vertical roads are counted. */
function drawZoneLegend(report) {
    const { doc } = report;
    const zones = [
        [1, 'Zone 1 south'],
        [2, 'Zone 2 middle'],
        [3, 'Zone 3 north'],
    ];
    report.ensureSpace(14);
    let y = report.y + 1;
    let x = PAGE.margin + 1;
    doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...COLOURS.ink);
    zones.forEach(([zone, label]) => {
        doc.setFillColor(ZONE_TINTS[zone]);
        doc.roundedRect(x, y - 2.6, 3.2, 3.2, 0.6, 0.6, 'F');
        doc.text(label, x + 5, y);
        x += 5 + doc.getTextWidth(label) + 7;
    });
    y += 4.2;
    doc.setFontSize(7.5).setTextColor(...COLOURS.muted);
    const note = doc.splitTextToSize(
        `Load-shedding zones: horizontal roads tinted by zone; a junction takes its horizontal road's zone. Vertical roads (${VERTICAL_ROADS}) are untinted - their queues count to the zone of the junction they queue at.`,
        CONTENT_WIDTH - 2
    );
    doc.text(note, PAGE.margin + 1, y);
    report.y = y + note.length * 3.4 + 3;
}

/** Comparison target order: blended adaptive, each sensor, then green wave - each over `powers` in payload order. */
function comparisonRows(data, variants, scope, powers) {
    const rank = new Map(variants.map((variant, i) => [variant.id, i]));
    return (data.pairedComparisons ?? [])
        .filter((c) => c.scope === scope.key && powers.includes(c.power_state))
        .map((c) => ({ ...c, variant: variants.find((v) => v.id === `${c.mode}|${c.sensor_mode ?? ''}`) }))
        .filter((c) => c.variant)
        .sort((a, b) => rank.get(a.variant.id) - rank.get(b.variant.id) || data.powerStates.indexOf(a.power_state) - data.powerStates.indexOf(b.power_state));
}

/**
 * A recovery delta with the recovered-run counts behind it ("ITS vs fixed"). Below the
 * minimum recovered runs per side the controller leaves the delta null - say why instead.
 * A reliable-but-null delta means fixed-time recovered in 0.0s, so there's no ratio: n/a.
 */
function fmtRecoveryDelta(c, metric, windowS = null) {
    if (!isOutage(c.power_state)) return '-';
    if (metric === 'wait') {
        // Mostly censored by the window, so the share that recovered - not a mean over the few that did.
        const share = (recovered, runs) => `${Math.round((recovered / runs) * 100)}%`;
        const capped = (meanS, recovered, runs) => cappedRecoveryS(meanS, recovered, runs, windowS);
        const subjectCapped = capped(c.recovery_wait_seconds, c.recovery_wait_recovered, c.runs);
        const baselineCapped = capped(c.baseline_recovery_wait_seconds, c.baseline_recovery_wait_recovered, c.baseline_runs);
        const cappedText = subjectCapped == null ? '' : `
capped ${Math.round(subjectCapped)} vs ${Math.round(baselineCapped)} s`;
        return `${share(c.recovery_wait_recovered, c.runs)} vs ${share(c.baseline_recovery_wait_recovered, c.baseline_runs)} recovered${cappedText}`;
    }
    const [delta, reliable, recovered, baselineRecovered] = metric === 'wait'
        ? [c.recovery_wait_delta_pct, c.recovery_wait_reliable, c.recovery_wait_recovered, c.baseline_recovery_wait_recovered]
        : [c.recovery_delta_pct, c.recovery_reliable, c.recovery_recovered, c.baseline_recovery_recovered];
    const counts = `${recovered}/${c.runs} vs ${baselineRecovered}/${c.baseline_runs}`;

    if (!reliable) return `too few runs\n${counts}`;
    // Both sides back within seconds: the difference in seconds, not a % of a few seconds.
    if (metric === 'throughput' && c.recovery_delta_seconds != null) return `${fmtDelta(c.recovery_delta_seconds, ' s')}\n${counts}`;

    return `${fmtDelta(delta, '%')}\n${counts}`;
}

/** Tints a delta cell green/red from the matching `*_improves` flag. */
function toneCell(cell, improves) {
    if (improves === null || improves === undefined) return;
    cell.styles.fillColor = improves ? COLOURS.better : COLOURS.worse;
    cell.styles.textColor = improves ? COLOURS.betterText : COLOURS.worseText;
    cell.styles.fontStyle = 'bold';
}

/** A paired delta with its 95% CI on the per-seed differences, e.g. "-23.6% ±1.2". */
function fmtPaired(delta, ci95, unit) {
    const text = fmtDelta(delta, unit);
    return delta == null || ci95 == null ? text : `${text}
±${ci95.toFixed(1)}`;
}

/** Tint only when the interval excludes zero - lower is better. */
function lowerIsBetter(delta, ci95) {
    if (delta == null || ci95 == null || Math.abs(delta) <= ci95) return null;
    return delta < 0;
}

/** "mode|power" -> "ITS vs fixed-time" lost arrivals per run, from the destination-routing rows (the sensors pooled per mode). Empty without routing rows. */
function lostArrivalsByCondition(routingMetrics) {
    const byKey = new Map((routingMetrics ?? []).filter((row) => row.arrivals_lost_per_run != null).map((row) => [`${row.controller_mode}|${row.power_state}`, row.arrivals_lost_per_run]));
    const out = new Map();
    for (const [key, lost] of byKey) {
        const [, power] = key.split('|');
        const fixed = byKey.get(`fixed|${power}`);
        if (key.startsWith('fixed|') || fixed == null) continue;
        out.set(key, `${Math.round(lost)} vs ${Math.round(fixed)}`);
    }
    return out;
}

function comparisonTable(report, data, variants, scope, { compact = false, powers } = {}) {
    // The cover's compact headline keeps to the blended adaptive average and green wave.
    const rows = comparisonRows(data, variants, scope, powers).filter((c) => !compact || c.variant.sensor === null || c.variant.sensor === 'average');
    const lostArrivals = lostArrivalsByCondition(data.routingMetrics);
    if (!rows.length) {
        report.paragraph('No paired comparisons yet - run the batch for this corridor first.');
        return;
    }
    // Each row's own cap: the scope's post-restore window under that row's power state.
    const windowFor = (c) => postRestoreWindowS(data, c.power_state, scope);

    const columns = [
        { header: 'ITS variant', value: (c) => c.variant.label },
        { header: 'Power', value: (c) => powerLabel(c.power_state) },
        { header: 'Avg wait', value: (c) => fmtPaired(c.wait_delta_pct, c.wait_delta_ci95_pct, '%'), improves: 'wait_improves' },
        // The tail next to the mean (total scope only): a mean alone can't tell "everyone a bit slower" from "a few stranded".
        ...(compact
            ? [
                  { header: 'Median wait', value: (c) => fmtPaired(c.median_wait_delta_pct, c.median_wait_delta_ci95_pct, '%'), improves: (c) => lowerIsBetter(c.median_wait_delta_pct, c.median_wait_delta_ci95_pct) },
                  { header: 'P95 wait', value: (c) => fmtPaired(c.p95_wait_delta_pct, c.p95_wait_delta_ci95_pct, '%'), improves: (c) => lowerIsBetter(c.p95_wait_delta_pct, c.p95_wait_delta_ci95_pct) },
              ]
            : []),
        { header: 'Throughput', value: (c) => fmtPaired(c.throughput_delta_pct, c.throughput_delta_ci95_pct, '%'), improves: 'throughput_improves' },
        { header: 'Cleared w/o stop', value: (c) => fmtPaired(c.cleared_delta_pp, c.cleared_delta_ci95_pp, ' pp'), improves: 'cleared_improves' },
        ...(compact && lostArrivals.size
            ? [
                  // Wait alone hides saturation: a controller that turns demand away at a full entry has a shorter queue to wait in.
                  { header: 'Lost arrivals / run (ITS vs fixed)', value: (c) => lostArrivals.get(`${c.mode}|${c.power_state}`) ?? 'n/a' },
              ]
            : []),
        ...(compact
            ? []
            : [
                  {
                      header: 'Recovery (wait)',
                      value: (c) => fmtRecoveryDelta(c, 'wait', windowFor(c)),
                      // Tinted on the capped-mean gap, not the recovered share: one run short of 100% against a 100% baseline is not a loss.
                      improves: (c) => {
                          if (!isOutage(c.power_state)) return null;
                          const windowS = windowFor(c);
                          const its = cappedRecoveryS(c.recovery_wait_seconds, c.recovery_wait_recovered, c.runs, windowS);
                          const baseline = cappedRecoveryS(c.baseline_recovery_wait_seconds, c.baseline_recovery_wait_recovered, c.baseline_runs, windowS);
                          if (its == null || !baseline || Math.abs(its - baseline) / baseline < CAPPED_GAP_MIN) return null;
                          return its < baseline;
                      },
                  },
                  // After wait: throughput is back within seconds for every controller, so it tells little.
                  { header: 'Recovery (thru)', value: (c) => fmtRecoveryDelta(c, 'throughput'), improves: 'recovery_improves' },
                  { header: 'Runs (ITS / fixed)', value: (c) => `${c.runs} / ${c.baseline_runs}` },
              ]),
    ];

    if (!compact && rows.some((c) => isOutage(c.power_state) && c.baseline_runs && c.baseline_recovery_wait_recovered === c.baseline_runs)) {
        report.paragraph('Recovery (wait): where the fixed-time baseline recovered in every run (100%), a single ITS run that did not recover reads as a loss in the share. The cell is tinted on the capped-mean gap (at least 10%) instead - read the shares as counts, not as a difference.');
    }

    report.table({
        head: [columns.map((column) => column.header)],
        body: rows.map((c) => columns.map((column) => column.value(c))),
        columnStyles: Object.fromEntries(columns.map((_, i) => [i, { halign: i < 2 ? 'left' : 'right' }])),
        didParseCell: (hook) => {
            if (hook.section !== 'body') return;
            const key = columns[hook.column.index].improves;
            if (key) toneCell(hook.cell, typeof key === 'function' ? key(rows[hook.row.index]) : rows[hook.row.index][key]);
        },
    });
}

/** One scope's P95 and max-wait deltas against fixed-time, with their paired CIs. */
function tailTable(report, data, variants, scope, powers) {
    const rows = comparisonRows(data, variants, scope, powers);
    if (!rows.length || !rows.some((c) => c.p95_wait_delta_pct != null || c.max_wait_delta_pct != null)) {
        report.paragraph('No tail comparison for this batch (per-scope P95/max not recorded).');
        return;
    }
    const columns = [
        { header: 'ITS variant', value: (c) => c.variant.label },
        { header: 'Power', value: (c) => powerLabel(c.power_state) },
        { header: 'P95 wait', value: (c) => fmtPaired(c.p95_wait_delta_pct, c.p95_wait_delta_ci95_pct, '%'), improves: (c) => lowerIsBetter(c.p95_wait_delta_pct, c.p95_wait_delta_ci95_pct) },
        { header: 'Max wait (run mean)', value: (c) => fmtPaired(c.max_wait_delta_pct, c.max_wait_delta_ci95_pct, '%'), improves: (c) => lowerIsBetter(c.max_wait_delta_pct, c.max_wait_delta_ci95_pct) },
    ];
    report.table({
        head: [columns.map((column) => column.header)],
        body: rows.map((c) => columns.map((column) => column.value(c))),
        columnStyles: Object.fromEntries(columns.map((_, i) => [i, { halign: i < 2 ? 'left' : 'right' }])),
        didParseCell: (hook) => {
            if (hook.section !== 'body') return;
            const improves = columns[hook.column.index].improves;
            if (improves) toneCell(hook.cell, improves(rows[hook.row.index]));
        },
    });
}

function perConditionTable(report, data, variants, scope, powers) {
    const m = (metric) => `${metric}${scope.suffix}`;
    const body = [];
    variants.forEach((variant) => {
        powers.forEach((power) => {
            const row = variant.row(power);
            if (!row) return;
            body.push([
                variant.label,
                powerLabel(power),
                String(row.runs),
                fmtCi(row[m('avg_wait_time')], row[`${m('avg_wait_time')}_ci95`]),
                fmtCi(row[m('throughput_per_min')], row[`${m('throughput_per_min')}_ci95`]),
                fmtCi(row[m('pct_cleared_without_stop')], row[`${m('pct_cleared_without_stop')}_ci95`]),
                isOutage(power) ? fmtWaitRecovery(row, m('time_to_recovery_wait_seconds'), postRestoreWindowS(data, power, scope)) : '-',
                isOutage(power) ? fmtRecovery(row, m('time_to_recovery_seconds')) : '-',
            ]);
        });
    });

    report.table({
        head: [['Variant', 'Power', 'Runs', 'Avg wait (s)', 'Throughput (/min)', 'Cleared w/o stop (%)', 'Recovery - wait', 'Recovery - thru']],
        body,
        columnStyles: { 0: { cellWidth: 38 }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' } },
    });
}

/** The outage's segments for one scope - pre / during / post for the total blackout, pre / stage 1 / stage 2 / post for rolling. */
function segmentedTable(report, variants, scope, power) {
    const m = (metric) => `${metric}${scope.suffix}`;
    const { segments } = OUTAGES[power];
    const body = variants
        .map((variant) => ({ variant, row: variant.row(power) }))
        .filter(({ row }) => row)
        .map(({ variant, row }) => [
            variant.label,
            ...segments.map((segment) => fmt(row[m(`avg_wait_time_${segment.key}`)])),
            ...segments.map((segment) => fmt(row[m(`throughput_per_min_${segment.key}`)])),
        ]);
    if (!body.length) {
        report.paragraph(`No ${powerLabel(power).toLowerCase()} runs for this corridor yet.`);
        return;
    }

    const valueColumns = segments.length * 2;
    report.table({
        head: [
            [
                { content: 'Variant', rowSpan: 2 },
                { content: 'Avg wait (s)', colSpan: segments.length, styles: { halign: 'center' } },
                { content: 'Throughput (/min)', colSpan: segments.length, styles: { halign: 'center' } },
            ],
            [...segments, ...segments].map((segment) => ({ content: segment.label, styles: { halign: 'right' } })),
        ],
        body,
        columnStyles: { 0: { cellWidth: 44 }, ...Object.fromEntries(Array.from({ length: valueColumns }, (_, i) => [i + 1, { halign: 'right' }])) },
    });
}

/** One scope's wait distribution: P95 and max per scope; the median is recorded for the total and zone scopes only. */
function distributionTable(report, variants, scope, powers) {
    const m = (metric) => `${metric}${scope.suffix}`;
    const withMedian = scope.key === 'total' || Boolean(scope.zone);
    const body = [];
    variants.forEach((variant) => {
        powers.forEach((power) => {
            const row = variant.row(power);
            if (!row) return;
            body.push([
                variant.label,
                powerLabel(power),
                fmt(row[m('avg_wait_time')]),
                ...(withMedian ? [fmt(row[m('median_wait_time')])] : []),
                fmt(row[m('p95_wait_time')]),
                fmt(row[m('max_wait_time')]),
                fmt(row[m('worst_wait_time')]),
            ]);
        });
    });

    const head = ['Variant', 'Power', 'Mean (s)', ...(withMedian ? ['Median (s)'] : []), 'P95 (s)', 'Max, run mean (s)', 'Max, worst run (s)'];
    report.table({
        head: [head],
        body,
        columnStyles: Object.fromEntries(head.slice(2).map((_, i) => [i + 2, { halign: 'right' }])),
    });
}

/** The segmented table's caption - what each column covers under `power`, and for a zone where its post column starts. */
function segmentedCaption(data, power, scope) {
    const carried = 'every controller runs the same all-way-stop control at a dark junction, but each carries in the queue it had when the power went - so the dark-time figures still differ by controller.';
    if (power !== 'rolling_blackout') return `Pre-outage / during-outage / post-recovery averages from cumulative counters. During the outage ${carried}`;

    const schedule = data.batchStamp?.rollingSchedule;
    const stage = (i, fallback) => {
        const w = schedule?.[i];
        return w ? `zone${w.zones.length > 1 ? 's' : ''} ${w.zones.join(' + ')} dark, minutes ${minute(w.fromS)}-${minute(w.toS)}` : fallback;
    };
    return `Pre-outage / stage 1 (${stage(0, 'zones 1 + 3 dark')}) / stage 2 (${stage(1, 'zone 2 dark')}) / post (after the final restore) averages from cumulative counters. Queues carry across each switch. At the dark zone's junctions ${carried}${scope.zone ? ` A zone's Post column starts at the FINAL restore, not at zone ${scope.zone}'s own.` : ''}`;
}

/**
 * One scope under one outage: the paired tables, the bar charts (normal baseline + this outage), the per-condition means,
 * the segmented table, the recovery curves (by-road scopes only - no zone curves are stored) and the recovery bars.
 */
function drawScope(report, data, variants, scope, power) {
    const m = (metric) => `${metric}${scope.suffix}`;
    const powers = ['normal', power];
    const card = { level: 'card' };
    report.heading(scope.label, `${scope.description}.${scope.zone ? ' Zone scopes overlap at shared junctions and don\'t sum to the total.' : ''}`, { swatch: ZONE_TINTS[scope.zone] ?? null });

    report.heading(
        'Every ITS variant vs fixed-time',
        `Percentage change against fixed-time on the same seeds and power state; ± is the 95% CI on the per-seed differences. Green = improvement, red = regression, uncoloured = inside the 95% CI (no clear difference). Recovery: wait first - throughput is back within seconds for every controller, so it tells little; wait recovery is often cut off by the end of the measured window. ${recoveryBasis(data, power, scope)}`,
        card
    );
    comparisonTable(report, data, variants, scope, { powers });

    report.heading('Tail vs fixed-time', 'P95 and the mean of each run\'s longest wait, as the change against fixed-time on the same seeds (negative is better; tinted only when the 95% CI excludes zero). A mean can improve while the few stranded vehicles get worse - that shows here.', card);
    tailTable(report, data, variants, scope, powers);

    const barAspect = 270 / 760;
    report.chartCard(`${scope.label} - average wait time`, 'seconds per vehicle · lower is better', barChartImage(variants, m('avg_wait_time'), powers, { unit: '', tickSuffix: 's' }), barAspect);
    report.chartCard(`${scope.label} - throughput`, 'vehicles cleared per minute · higher is better', barChartImage(variants, m('throughput_per_min'), powers, { unit: '' }), barAspect);
    report.chartCard(`${scope.label} - cleared without stopping`, '% of vehicles · higher is better', barChartImage(variants, m('pct_cleared_without_stop'), powers, { unit: '', tickSuffix: '%' }), barAspect);

    report.heading('Per-condition means', `Mean across reps, ± 95% confidence half-width on that condition's own mean. Recovery = seconds after power returns until the metric is back to its pre-cut level. ${recoveryBasis(data, power, scope)}`, card);
    perConditionTable(report, data, variants, scope, powers);

    report.heading(`${powerLabel(power)}, segmented`, segmentedCaption(data, power, scope), card);
    segmentedTable(report, variants, scope, power);

    const lineAspect = 300 / 760;
    const bandNote = power === 'rolling_blackout' ? 'shaded bands = dark windows by zone, all power back at the right edge of the last' : 'shaded band = outage window, power restored at its right edge';
    const waitLine = scope.zone ? null : recoveryLineImage(data, variants, m('avg_wait_time'), power);
    const thruLine = scope.zone ? null : recoveryLineImage(data, variants, m('throughput_per_min'), power);
    if (waitLine) report.chartCard(`${scope.label} - recovery after a power cut, wait time`, `average wait, s per vehicle · ${bandNote}`, waitLine, lineAspect);
    if (thruLine) report.chartCard(`${scope.label} - recovery after a power cut, throughput`, `vehicles cleared per minute · ${bandNote}`, thruLine, lineAspect);

    drawRecoveryTimes(report, data, variants, scope, power);
}

/** The two time-to-recovery bar charts side by side, each timed from the scope's own restore and capped at its own window. */
function drawRecoveryTimes(report, data, variants, scope, power) {
    const charts = [
        { title: `${scope.label} - time to recovery, wait`, metric: `time_to_recovery_wait_seconds${scope.suffix}` },
        { title: `${scope.label} - time to recovery, throughput`, metric: `time_to_recovery_seconds${scope.suffix}` },
    ].map((chart) => ({ ...chart, title: report.numbered(chart.title, 'card') })).map((chart) => {
        const outage = variants.filter((v) => v.row(power));
        const measured = outage.filter((v) => v.row(power)[chart.metric] != null);
        return { ...chart, image: recoveryTimeImage(variants, chart.metric, power), bars: measured.length, missing: outage.filter((v) => !measured.includes(v)) };
    });
    if (!charts.some((chart) => chart.image)) return;

    const { doc } = report;
    const width = (CONTENT_WIDTH - 4) / 2;
    const heightFor = (bars) => (width - 4) * ((60 + bars * 38) / 380);
    const imageHeight = Math.max(...charts.map((chart) => heightFor(chart.bars)));
    // Which restore the bars are timed from - a zone's own under rolling - and the cap a wait recovery runs to.
    const restoreS = restoreSeconds(data, power, scope);
    const windowS = postRestoreWindowS(data, power, scope);
    const from = scope.zone && power === 'rolling_blackout' ? `zone ${scope.zone}'s own restore` : power === 'rolling_blackout' ? 'the final restore' : 'the restore';
    const basis = `from ${from}${restoreS == null ? '' : ` (min ${minute(restoreS)})`}${windowS == null ? '' : ` · cap ${minute(windowS)} min`}`;
    report.ensureSpace(imageHeight + 28);
    const top = report.y;

    charts.forEach((chart, i) => {
        const x = PAGE.margin + i * (width + 4);
        doc.setDrawColor(...COLOURS.rule).setLineWidth(0.3);
        doc.roundedRect(x, top, width, imageHeight + 24, 2, 2, 'S');
        // A zone's longer title steps down a size rather than lose its tail to the card edge.
        doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...COLOURS.ink);
        if (doc.getTextWidth(chart.title) > width - 6) doc.setFontSize(8.5);
        doc.text(doc.splitTextToSize(chart.title, width - 6)[0], x + 3, top + 5.5);
        doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...COLOURS.muted);
        doc.text('seconds back to pre-cut level · lower is better · (recovered/runs)', x + 3, top + 9.5);
        doc.text(basis, x + 3, top + 13);
        if (chart.image) doc.addImage(chart.image, 'PNG', x + 2, top + 15, width - 4, heightFor(chart.bars), undefined, 'FAST');
        if (chart.missing.length) {
            doc.setFontSize(7).setTextColor(...COLOURS.worseText);
            doc.text(doc.splitTextToSize(`Did not recover in window: ${chart.missing.map((v) => v.label).join(', ')}`, width - 6), x + 3, top + imageHeight + 19);
        }
    });
    report.y = top + imageHeight + 28;

    // The zone 1/3 caveat again under the bars, where the numbers are read.
    if (scope.zone && power === 'rolling_blackout' && /NOT comparable/.test(recoveryBasis(data, power, scope))) {
        report.paragraph(recoveryBasis(data, power, scope));
    }
}

/**
 * Destination routing batches only: trips, their delay over free flow, and how often a trip didn't go to plan - the normal
 * baseline and this section's outage. Always headed, so the section keeps its numbering on a random-turning batch.
 */
function drawRoutingTrips(report, data, powers) {
    const controllerLabel = { fixed: 'Fixed-time', green_wave: 'Green wave', adaptive: 'Adaptive', coordinated_adaptive: 'Coordinated adaptive' };
    const rows = (data.routingMetrics ?? [])
        .filter((row) => powers.includes(row.power_state))
        .sort((a, b) => powers.indexOf(a.power_state) - powers.indexOf(b.power_state));
    if (!rows.length) {
        report.heading('Destination routing', null);
        report.paragraph(data.batchStamp?.routingMode === 'destination' ? 'No destination-routing trip figures for these power states.' : 'Not a destination-routing batch - vehicles turned at random, so there are no trips to report.');
        return;
    }
    report.heading(
        'Destination routing',
        'Trip delay: time beyond free-flow driving along the route, over trips that reached their intended destination. Missed driveways: pull-offs that missed their driveway first time. Diverted: trips that ended somewhere else - read the tier-driven results with this alongside. Avg wait: the average wait over these runs (total scope). Driveway wait: how long a car leaving a block waited to pull out, in neither its trip nor any wait figure - so it sits next to Avg wait. It is therefore excluded from the wait comparisons, and it grows where queues stand across driveway exits, so it is larger in a blackout and dark-network delay is understated. Still in driveways: cars that had not got out when the run ended. Lost arrivals: map-edge demand turned away by a full entry.'
    );
    report.table({
        head: [['Controller', 'Power', 'Runs', 'Avg wait (s)', 'Driveway wait (s)', 'Still in driveways', 'Mean trip (s)', 'Trip delay (s)', 'Missed driveways (%)', 'Missed turns / run', 'Diverted (%)', 'Lost arrivals / run']],
        body: rows.map((row) => [
            controllerLabel[row.controller_mode] ?? row.controller_mode,
            powerLabel(row.power_state),
            String(row.runs),
            fmt(row.mean_wait),
            fmt(row.mean_driveway_wait),
            row.still_in_driveways == null ? 'n/a' : Number(row.still_in_driveways).toFixed(0),
            fmt(row.mean_trip_time),
            fmt(row.mean_trip_delay),
            fmt(row.missed_driveways_pct),
            row.missed_turns_per_run == null ? 'n/a' : Number(row.missed_turns_per_run).toFixed(0),
            fmt(row.diversion_pct),
            row.arrivals_lost_per_run == null ? 'n/a' : Number(row.arrivals_lost_per_run).toFixed(0),
        ]),
        columnStyles: Object.fromEntries([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((column) => [column, { halign: 'right' }])),
    });
}

/** The warm-up probe's per-controller settle times (from empty, normal power) - how much cushion the warm-up leaves each. */
function warmupSettleNote(settle) {
    if (!settle) return null;
    const labels = { fixed: 'fixed-time', green_wave: 'green wave', adaptive: 'adaptive (inductive loop)', coordinated_adaptive: 'coordinated adaptive (inductive loop)' };
    const minutes = (value) => (value == null ? 'never' : `${value} min`);
    const parts = Object.entries(settle).map(
        ([mode, scopes]) => `${labels[mode] ?? mode} ${minutes(scopes.total)} (main arterial ${minutes(scopes.arterial)}, side streets ${minutes(scopes.sideStreet)})`
    );
    return `Warm-up probe, from empty at normal power - when each controller's average wait levelled off: ${parts.join('; ')}. The warm-up is the slowest of these x ${WARMUP_SAFETY_MARGIN}, capped at ${MAX_WARMUP_TICKS / 600} min; "never" is a scope still drifting. The probe runs ${PROBE_REPLICATIONS} seeds per controller with the inductive loop only, so these settle times are a noisy sizing step for the warm-up, not findings - a scope that settles later than its parts, or one sensor's slow side streets, is within that noise.`;
}

const GREEN_END_LABELS = {
    yield: 'Arterial yielded',
    gapOut: 'Gapped out',
    forceOff: 'Forced off',
    maxOut: 'Maxed out',
    platoonEarly: 'Ended early for a platoon',
    reservice: 'Cross street served again',
    sideCap: 'Side-street wait cap',
};

/**
 * Coordinated adaptive batches only: what the coordination actually did (server CoordinationMetrics, from each run's
 * coordination_stats) - per sensor and power state, how greens ended, and which junctions coordinated.
 */
/**
 * Coordinated adaptive against adaptive itself - same sensor, same seeds - with the CI on the per-seed differences. Against
 * fixed-time both look good; this says what the coordination layers added on top of plain actuation.
 */
function drawVersusAdaptive(report, versus, conditions) {
    if (!versus || !Object.keys(versus).length) return;
    report.heading(
        'Coordinated vs adaptive',
        'Coordinated adaptive against adaptive with the same sensor on the same seeds and power state; ± is the 95% CI on the per-seed differences (the "avg. of sensors" row pairs each seed\'s sensor mean). Wait, P95 and max: negative is better. Throughput and cleared-without-stopping: positive is better. Green = clear improvement, red = clear regression, uncoloured = inside the CI. Recovery: throughput, seconds.'
    );
    const sensors = ['average', ...SENSOR_ORDER];
    const powers = POWER_ORDER.filter((power) => conditions.some((row) => row.power_state === power));
    const rows = powers.flatMap((power) => sensors.map((sensor) => ({ sensor, power, paired: versus[`${sensor}|${power}`] }))).filter((row) => row.paired);
    const delta = (column, unit, lowerBetter) => ({
        value: (row) => fmtPaired(row.paired[column]?.delta, row.paired[column]?.ci95, unit),
        improves: (row) => {
            const d = row.paired[column];
            if (!d || Math.abs(d.delta) <= d.ci95) return null;
            return lowerBetter ? d.delta < 0 : d.delta > 0;
        },
    });
    const columns = [
        { header: 'Sensor', value: (row) => (row.sensor === 'average' ? 'Avg. of sensors' : SENSOR_LABELS[row.sensor] ?? row.sensor) },
        { header: 'Power', value: (row) => powerLabel(row.power) },
        { header: 'Wait, total', ...delta('avg_wait_time', '%', true) },
        { header: 'Wait, arterial', ...delta('avg_wait_time_arterial', '%', true) },
        { header: 'Wait, side streets', ...delta('avg_wait_time_side_street', '%', true) },
        { header: 'P95, total', ...delta('p95_wait_time', '%', true) },
        { header: 'P95, side streets', ...delta('p95_wait_time_side_street', '%', true) },
        { header: 'Max, side streets', ...delta('max_wait_time_side_street', '%', true) },
        { header: 'Throughput', ...delta('throughput_per_min', '%', false) },
        { header: 'Cleared w/o stop', ...delta('pct_cleared_without_stop', ' pp', false) },
    ];
    report.table({
        head: [columns.map((column) => column.header)],
        body: rows.map((row) => columns.map((column) => column.value(row))),
        columnStyles: Object.fromEntries(columns.map((_, i) => [i, { halign: i < 2 ? 'left' : 'right' }])),
        didParseCell: (hook) => {
            if (hook.section !== 'body') return;
            const improves = columns[hook.column.index].improves;
            if (improves) toneCell(hook.cell, improves(rows[hook.row.index]));
        },
    });
}

function roadLabel(road) {
    return road.name && road.name !== road.road_id ? `${road.name} (${road.road_id})` : road.road_id;
}

/**
 * Wait per road under `powers` (the normal baseline and this section's outage): each controller's mean, and the paired
 * differences that show where a gain or loss sits (a main road, or the streets crossing it). By road only - no zone split.
 */
function drawRoadWaits(report, data, powers) {
    const roadWaits = (data.roadWaits ?? []).filter((row) => powers.includes(row.power_state));
    report.heading(
        'Wait by road',
        roadWaits.length
            ? 'Where the wait is - each road on its own. Mean wait (s) a vehicle built up on each road, over the vehicles that used it - a trip over several roads is in each, with only the wait it built up there. Adaptive and coordinated adaptive: the sensors averaged per seed. The "vs" columns: paired change on the same seeds, % of the baseline, ± 95% CI; tinted only where the CI excludes zero (negative is better).'
            : null
    );
    if (!roadWaits.length) {
        report.paragraph('No per-road waits recorded for these power states.');
        return;
    }
    const labels = { arterial: 'Main roads', side: 'Side streets' };
    powers.forEach((power) => {
        ['arterial', 'side'].forEach((scope) => {
            const scoped = roadWaits.filter((row) => row.power_state === power && row.scope === scope);
            if (!scoped.length) return;
            const rows = scoped.filter((row) => ['fixed', 'adaptive', 'green_wave', 'coordinated_adaptive'].some((mode) => (row[mode] ?? 0) >= ROAD_WAIT_MIN_S));
            const hidden = scoped.length - rows.length;
            report.heading(`${labels[scope]} - ${powerLabel(power)}`, null, { level: 'card' });
            const pair = (key) => ({ value: (row) => fmtPaired(row[key]?.delta, row[key]?.ci95, '%'), improves: (row) => lowerIsBetter(row[key]?.delta, row[key]?.ci95) });
            const columns = [
                { header: 'Road', value: roadLabel },
                { header: 'Fixed', value: (row) => fmt(row.fixed) },
                { header: 'Adaptive', value: (row) => fmt(row.adaptive) },
                { header: 'Green wave', value: (row) => fmt(row.green_wave) },
                { header: 'Coordinated', value: (row) => fmt(row.coordinated_adaptive) },
                { header: 'Adaptive vs fixed', ...pair('adaptive_vs_fixed') },
                { header: 'Coordinated vs fixed', ...pair('coordinated_vs_fixed') },
                { header: 'Coordinated vs adaptive', ...pair('coordinated_vs_adaptive') },
            ];
            if (rows.length) report.table({
                head: [columns.map((column) => column.header)],
                body: rows.map((row) => columns.map((column) => column.value(row))),
                columnStyles: Object.fromEntries(columns.map((_, i) => [i, { halign: i === 0 ? 'left' : 'right' }])),
                didParseCell: (hook) => {
                    if (hook.section !== 'body') return;
                    const improves = columns[hook.column.index].improves;
                    if (improves) toneCell(hook.cell, improves(rows[hook.row.index]));
                },
            });
            if (hidden) report.paragraph(`${hidden} ${hidden === 1 ? 'road' : 'roads'} under ${ROAD_WAIT_MIN_S} s mean wait for every controller hidden.`);
            if (scope === 'arterial') drawRoadWaitStages(report, rows, power, columns.slice(1));
        });
    });
}

/**
 * The main roads' waits split by outage stage (by when each vehicle cleared): locates which road carries a stage's
 * gap between controllers. Only for runs that recorded the split - older batches skip it.
 */
function drawRoadWaitStages(report, roads, power, valueColumns) {
    const rows = roads.flatMap((road) => Object.entries(road.stages ?? {}).map(([stage, figures]) => ({ ...figures, road, stage })));
    if (!rows.length) return;
    report.heading(
        `Main roads by stage - ${powerLabel(power)}`,
        'The same figures split by outage stage, each vehicle counted in the stage it cleared in - so a queue built in one stage and cleared in the next is charged to the next.',
        { level: 'card' }
    );
    const columns = [
        { header: 'Road', value: (row) => roadLabel(row.road) },
        { header: 'Stage', value: (row) => STAGE_LABELS[row.stage] ?? row.stage },
        ...valueColumns,
    ];
    report.table({
        head: [columns.map((column) => column.header)],
        body: rows.map((row) => columns.map((column) => column.value(row))),
        columnStyles: Object.fromEntries(columns.map((_, i) => [i, { halign: i < 2 ? 'left' : 'right' }])),
        didParseCell: (hook) => {
            if (hook.section !== 'body') return;
            const improves = columns[hook.column.index].improves;
            if (improves) toneCell(hook.cell, improves(rows[hook.row.index]));
        },
    });
}

/**
 * One outage section (1 = total blackout, 2 = rolling): every scope it covers, then the wait distribution, destination
 * routing and wait by road - each beside the normal-power baseline. A batch without that state's runs gets a note instead.
 */
function drawOutageSection(report, data, variants, power) {
    const outage = OUTAGES[power];
    const powers = ['normal', power];
    report.newPage();
    report.sectionTitle(outage.title, outage.subtitle, SECTION[power]);
    if (!variants.some((variant) => variant.row(power))) {
        report.paragraph(`No ${outage.title.toLowerCase()} runs in this batch - this section fills in once the batch includes the ${outage.title.toLowerCase()} power state.`);
        return;
    }

    outage.scopes.forEach((scope, i) => {
        if (i) report.newPage();
        drawScope(report, data, variants, scope, power);
    });

    report.newPage();
    report.heading('Wait distribution', 'Per scope - a mean alone can\'t tell "everyone waits a bit longer" apart from "a few are stranded".');
    outage.scopes.forEach((scope) => {
        report.heading(scope.label, scope.description, { level: 'card', swatch: ZONE_TINTS[scope.zone] ?? null });
        distributionTable(report, variants, scope, powers);
    });
    drawRoutingTrips(report, data, powers);
    drawRoadWaits(report, data, powers);
}

/** The coordination stage keys in time order, and how a stage is headed. */
const STAGE_LABELS = { pre: 'Pre-outage', during: 'Dark', stage1: 'Stage 1', stage2: 'Stage 2', post: 'Post' };
/** A route cycle only means something while all of Jan Shoba is lit - before the first cut and after the last restore. */
const CYCLE_STAGES = new Set(['pre', 'post']);

/** A restore's label from the engine's stage tag when the resync hold fired (rolling: into stage 2 = zones 1 + 3 back). */
function restoreLabel(data, restore) {
    if (restore.stage === 'post' || restore.stage === 'during') return 'All power back';
    const schedule = data.batchStamp?.rollingSchedule;
    const back = schedule?.filter((w) => Math.abs(w.toS - restore.at_s) < 120).flatMap((w) => w.zones ?? []);
    return back?.length ? `Zone${back.length > 1 ? 's' : ''} ${back.join(' + ')} back (${STAGE_LABELS[restore.stage] ?? restore.stage} starts)` : `${STAGE_LABELS[restore.stage] ?? restore.stage} starts`;
}

function drawCoordination(report, data, metrics, number) {
    report.sectionTitle('Coordination', 'Coordinated adaptive only - what the coordination layers did over the measured window', number);
    if (!metrics?.conditions?.length) {
        report.paragraph('No coordinated adaptive runs in this batch.');
        return;
    }

    report.heading(
        'Per sensor and power state',
        'Married: share of junction-time on the common cycle (the rest ran as plain adaptive - selective coordination, the resync hold after power returns, or dark in a blackout). Cycle: mean common cycle on the routes where a junction married - each arterial, and Jan Shoba coordinated along its own length. Re-plans: self-tuning updates per measured hour, all routes. Resync holds: per run, after power returns (load shedding restores twice). Messages / holds / early ends: platoon messages posted, arterial greens held for an arriving platoon, cross greens ended early for one - per measured hour.'
    );
    const sensorRank = (sensor) => SENSOR_ORDER.indexOf(sensor);
    const conditions = [...metrics.conditions].sort((a, b) => POWER_ORDER.indexOf(a.power_state) - POWER_ORDER.indexOf(b.power_state) || sensorRank(a.sensor_mode) - sensorRank(b.sensor_mode));
    const sensorLabel = (row) => SENSOR_LABELS[row.sensor_mode] ?? row.sensor_mode;
    report.table({
        head: [['Sensor', 'Power', 'Runs', 'Married (%)', 'Cycle (s)', 'Re-plans / h', 'Resync holds', 'Messages / h', 'Holds / h', 'Early ends / h']],
        body: conditions.map((row) => [
            sensorLabel(row),
            powerLabel(row.power_state),
            String(row.runs),
            fmt(row.married_pct),
            fmt(row.mean_cycle_s),
            fmt(row.retunes_per_hour),
            fmt(row.recovery_holds),
            row.messages_per_hour == null ? 'n/a' : Number(row.messages_per_hour).toFixed(0),
            fmt(row.holds_per_hour),
            fmt(row.early_ends_per_hour),
        ]),
        columnStyles: Object.fromEntries([2, 3, 4, 5, 6, 7, 8, 9].map((column) => [column, { halign: 'right' }])),
    });

    // Jan Shoba by stage: its route crosses every zone, so under a rolling blackout part of it is dark in each stage.
    const staged = conditions.filter((row) => row.by_stage && Object.keys(row.by_stage).length);
    if (staged.length) {
        const stages = Object.keys(STAGE_LABELS).filter((stage) => staged.some((row) => row.by_stage[stage]));
        report.heading(
            'Jan Shoba by stage',
            'Married: share of signal-time married in each stage of the outage, over every signalised junction on Jan Shoba - including the two Pretorius crossings, which marry on Pretorius\'s cycle, not Jan Shoba\'s (3.6 lists them under pretorius). Route cycle: the Jan Shoba route\'s own planned common cycle, held even while none of its junctions marry - so it is not the cycle of the married junctions counted in the married share. Shown before the first cut and after the last restore only (see the note under the table).'
        );
        report.table({
            head: [
                [
                    { content: 'Sensor', rowSpan: 2 },
                    { content: 'Power', rowSpan: 2 },
                    { content: 'Married, Jan Shoba (%)', colSpan: stages.length, styles: { halign: 'center' } },
                    { content: 'Route cycle (s)', colSpan: stages.length, styles: { halign: 'center' } },
                ],
                [...stages, ...stages].map((stage) => ({ content: STAGE_LABELS[stage], styles: { halign: 'right' } })),
            ],
            body: staged.map((row) => [
                sensorLabel(row),
                powerLabel(row.power_state),
                ...stages.map((stage) => (row.by_stage[stage] ? fmt(row.by_stage[stage].married_pct) : '')),
                ...stages.map((stage) => {
                    if (!row.by_stage[stage]) return '';
                    return CYCLE_STAGES.has(stage) ? fmt(row.by_stage[stage].route_cycle_s) : '—';
                }),
            ]),
            columnStyles: Object.fromEntries(Array.from({ length: stages.length * 2 }, (_, i) => [i + 2, { halign: 'right' }])),
        });
        report.paragraph('—  No route cycle while the outage runs: part of Jan Shoba\'s route is dark in every stage (all of it in a total blackout), so a mean cycle over the lit remainder means nothing. Blank: the stage isn\'t part of that power state.');

        const restores = staged.flatMap((row) => (row.restores ?? []).map((restore) => ({ row, restore })));
        if (restores.length) {
            report.heading('Resync holds per restore', 'Each time power comes back the restored coordinated junctions run as plain adaptive for the resync hold before marrying back. At: mean measured second of the restore. Hold: mean hold, seconds. Per run: restore events per run.');
            report.table({
                head: [['Sensor', 'Power', 'Restore', 'At (min)', 'Hold (s)', 'Per run']],
                body: restores.map(({ row, restore }) => [
                    sensorLabel(row),
                    powerLabel(row.power_state),
                    restoreLabel(data, restore),
                    restore.at_s == null ? 'n/a' : (restore.at_s / 60).toFixed(1),
                    fmt(restore.hold_s),
                    fmt(restore.per_run),
                ]),
                columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
            });
        }
    }

    drawVersusAdaptive(report, metrics.versus_adaptive, conditions);

    report.heading('How greens ended', 'Share of every green that ended, by why - per sensor and power state.');
    const reasons = Object.keys(GREEN_END_LABELS).filter((reason) => conditions.some((row) => row.green_ends_pct?.[reason]));
    report.table({
        head: [['Sensor', 'Power', ...reasons.map((reason) => `${GREEN_END_LABELS[reason]} (%)`)]],
        body: conditions.map((row) => [sensorLabel(row), powerLabel(row.power_state), ...reasons.map((reason) => fmt(row.green_ends_pct?.[reason] ?? 0))]),
        columnStyles: Object.fromEntries(reasons.map((_, i) => [i + 2, { halign: 'right' }])),
    });

    // One married column per power state the batch ran - married_pct_by_power, or the two old columns for older payloads.
    const marriedBy = (row, power) => row.married_pct_by_power?.[power] ?? (power === 'normal' ? row.married_pct : power === 'load_shedding' ? row.married_pct_load_shedding : null);
    const junctionPowers = POWER_ORDER.filter((power) => conditions.some((row) => row.power_state === power));
    report.heading(
        'Per junction',
        'Every sensor pooled: how much of the time each junction coordinated in each power state (the dark time counts as unmarried, so an outage share is of the whole measured window), the route it coordinated on (its arterial, or "route:Jan Shoba"), and the mean common cycle of that route at normal power ("-" where no junction on the route ever coordinated, so no cycle was run). Junctions on no strong link run as plain adaptive throughout (0%).'
    );
    report.table({
        head: [['Junction', 'Route', ...junctionPowers.map((power) => `Married, ${powerLabel(power).toLowerCase()} (%)`), 'Route cycle (s)']],
        body: metrics.junctions.map((row) => [row.node_id, row.route_id, ...junctionPowers.map((power) => fmt(marriedBy(row, power))), row.mean_cycle_s == null ? '-' : fmt(row.mean_cycle_s)]),
        columnStyles: Object.fromEntries(Array.from({ length: junctionPowers.length + 1 }, (_, i) => [i + 2, { halign: 'right' }])),
    });
}

/**
 * The gates and thresholds the actuated controllers ran on, so a coordination result can be reproduced: the batch's own
 * coordination settings (stamped on its runs), the actuation rules from the code the report was built with.
 */
function thresholdNotes(data) {
    const coordination = data.batchStamp?.coordination;
    if (!coordination) return [];
    const c = { ...COORDINATED_DEFAULTS, ...coordination };
    const a = ADAPTIVE_DEFAULTS;
    const on = (flag) => (flag ? 'on' : 'off');
    return [
        `Adaptive actuation (every sensor, plain and coordinated): a green gaps out after ${a.gapOutS} s without a detection, never shorter than ${a.minGreen} s, capped at ${a.maxGreen} s; the other phase is served once its call has persisted ${a.callDebounceS} s - one call rule for every sensor (2026-10-16); counts and queue extent are observed but never decide the switch.`,
        `Coordinated adaptive gates: a link marries when the busiest-lane arterial flow at its two ends averages at least ${c.marryFlowPerLaneMin} veh/min per lane and a platoon crosses it within ${c.marryMaxTravelS} s, and divorces below ${Math.round(c.divorceRatio * 100)}% of that; selective marriage ${on(c.selective)}, connector routes (Jan Shoba) ${on(c.connectorRoutes)}, forced route marriage ${on(c.forceRoutes)}. Platoon messages ${on(c.platoonMessages)}: a platoon of ${c.platoonMinCars}+ vehicles holds the arterial green up to ${c.platoonExtendMaxS} s past its yield point when due within ${c.platoonLookaheadS} s, and a thinned-out cross green (${c.earlyStartGapS} s without detection) ends early for a platoon due within amber + all-red + ${c.earlyStartLeadS} s. Self-tuning ${on(c.selfTuning)}: re-plan every ${c.retuneEveryCycles} common cycles, flow smoothing ${c.retuneSmoothing}, common cycle moves at most ${c.retuneMaxStepS} s per update, saturated stages boosted ${Math.round(c.saturatedBoost * 100)}%${c.freezeAfterWarmup ? '; FROZEN after warm-up (ablation)' : ''}.`,
        `Coordinated adaptive levers: re-service of a cross call within its own window ${on(c.reservice)}; side-street max-wait cap ${on(c.sideWaitCap)} (${c.sideMaxWaitS} s); resync hold after power returns ${on(c.recoveryHold)} (${c.recoveryHoldS} s on plain adaptive before marrying back).`,
    ];
}

/** The sensor observation models (sim/sensorSpecs.js's field set) - what each adaptive variant could see. */
function sensorNotes() {
    const f = SENSOR_SPEC_SETS.field;
    const lag = (mode) => `${f[mode].latency.ms} ms -> ${latencyTicks(f[mode], 0.1)} tick(s)`;
    return [
        `Sensor models (field specs, 2026-10-15): variants differ only in what they observe; the call rule and gap-out rule are shared. Every sensor's gap-out zone is the 0-${f.inductive_loop.gapOut.lengthM} m behind the stop line. Loop: an ${f.inductive_loop.call.lengthM} m long presence loop, no count (${lag('inductive_loop')}). Magnetometer: stop-bar pucks over the same ${f.magnetometer.call.lengthM} m plus an advance puck ${f.magnetometer.advance[0].centreM} m back (no published placement - the distance was chosen by test runs; the sensor is modelled on Sensys Networks FlexMag: 3-axis magnetometer, 128 Hz sampling, advance-detection mode, per its product page and datasheet) that extends the green and reports a queue reaching it (${lag('magnetometer')}, radio slot wait). Radar (UMRR-11 Type 132, medium range): stopped-vehicle count and speed over ${f.radar.queue.lengthM} m, count smoothed over ${f.radar.outputs.count.filter.windowS} s (${lag('radar')}, 3 x 55 ms cycles). Camera: stopped-vehicle count and speed over ${f.camera.queue.lengthM} m (${lag('camera')}). Latency rounds up to whole ticks. This is an errors-disabled baseline: miss, false-call, crosstalk and count-noise rates are zero, so the comparison isolates observation geometry and information content rather than representing physical sensors in full; assumed error rates are for sensitivity runs only. Batches before 2026-10-15 used the earlier sensor model (their sensor spec reads "not recorded" in the batch line), so their per-sensor results are not comparable with these.`,
    ];
}

/** The rolling schedule as words, e.g. "zones 1 + 3 dark minutes 15-30, then zone 2 dark minutes 30-45". */
function rollingScheduleText(data) {
    const schedule = data.batchStamp?.rollingSchedule;
    if (!schedule?.length) return 'zones 1 + 3 dark minutes 15-30, then zone 2 dark minutes 30-45 (this batch ran no load shedding)';
    return schedule.map((w) => `zone${w.zones.length > 1 ? 's' : ''} ${w.zones.join(' + ')} dark minutes ${minute(w.fromS)}-${minute(w.toS)}`).join(', then ');
}

/**
 * Which seeds each power state ran on: the stamp's own per-state seeds when it records them, else the rule in
 * experimentalMatrix.js's seedForRep() (the code the report was built with) - a state off the normal seeds says by how much.
 */
function seedNote(data) {
    const stamp = data.batchStamp;
    const range = stamp?.firstSeed != null ? ` Seeds in this batch: ${stamp.firstSeed}-${stamp.lastSeed}.` : '';
    if (stamp?.seedsByPower) {
        const entries = POWER_ORDER.filter((power) => stamp.seedsByPower[power]).map((power) => [power, stamp.seedsByPower[power]]);
        const ranges = new Set(entries.map(([, seeds]) => `${seeds.first}-${seeds.last}`));
        if (entries.length > 1 && ranges.size === 1) {
            return `One seed set for every power state: rep r of a condition runs on the same seed at normal power and in each blackout, so the power states are paired seed for seed.${range}`;
        }
        const parts = entries.map(([power, seeds]) => `${powerLabel(power)} ${seeds.first}-${seeds.last}`);
        return `Seeds by power state: ${parts.join('; ')}. Comparisons are always paired within one power state, so separate seed sets never mix inside a delta.`;
    }
    const offset = (power) => seedForRep(0, power, 0) - seedForRep(0, 'normal', 0);
    const outages = POWER_ORDER.filter(isOutage);
    if (outages.every((power) => offset(power) === 0)) {
        return `One seed set for every power state: rep r of a condition runs on base seed + r at normal power, in the total blackout and under load shedding alike, so all three are paired seed for seed.${range}`;
    }
    const parts = outages.map((power) =>
        offset(power) === 0 ? `the ${powerLabel(power).toLowerCase()} runs on the normal-power seeds (base + rep)` : `the ${powerLabel(power).toLowerCase()} on its own set, offset by +${offset(power)} (base + ${offset(power)} + rep)`
    );
    return `Seeds: ${parts.join('; ')}. Comparisons are always paired within one power state, so the offset never mixes seeds inside a delta.${range}`;
}

function drawMethodNotes(report, data, number) {
    const minRecoveredRuns = data.minRecoveredRuns ?? 10;
    const stamp = data.batchStamp;
    // The warm-up is measured per batch by the probe (sim/warmupProbe.js) and stored on each run.
    const warmup = data.batchWarmupLabel
        ? `a ${data.batchWarmupLabel} warm-up, measured for this batch by the warm-up probe${data.hasNonStationaryBatch ? ' (capped at its maximum: at least one controller never settled)' : ''},`
        : 'a warm-up (not recorded for this batch)';
    const measured = stamp?.measuredMinutes ?? 90;
    // Post-restore windows (= wait-recovery caps) per state and scope, from the stamp where it has them.
    const capMin = (power, scopeKey, fallbackS) => {
        const seconds = stamp?.postRestoreWindowSByScope?.[power]?.[scopeKey] ?? fallbackS;
        return seconds == null ? '-' : minute(seconds);
    };
    const zoneRefs = `${partRef('rolling_blackout', 'zone1')}-${partRef('rolling_blackout', 'zone3')}`;
    report.sectionTitle('Method notes', null, number);
    const settleNote = warmupSettleNote(stamp?.warmupSettleMinutes);
    [
        `Every condition (controller mode x power state, with adaptive and coordinated adaptive further split by sensor model) gets 30 seeded repetitions per batch; the Runs columns show how many are pooled into each figure here. Each run discards ${warmup} before measuring ${measured} simulated minutes at dt = 0.1 s - the same ${measured}-minute measured window for every power state.`,
        ...(settleNote ? [settleNote] : []),
        seedNote(data),
        `Wait accounting: ${stamp?.waitAccounting ?? 'not recorded'}. The total scope counts every vehicle once with its whole trip's wait; Main arterial and Side streets each count every vehicle that used them, with only the wait it built up on their roads - so a trip over both is in both, and the two don't add up to the total.`,
        `Total blackout (section ${SECTION.load_shedding}): every junction loses power ${stamp?.outageStartMinutes ?? '-'} min into the measured window and gets it back at ${stamp?.outageEndMinutes ?? '-'} min. While the lights are dark every controller falls back to all-way-stop behaviour. Stored internally as load_shedding - not the load shedding of section ${SECTION.rolling_blackout}, which is stored as rolling_blackout.`,
        `Load shedding (section ${SECTION.rolling_blackout}): ${rollingScheduleText(data)}, then everything lit. A dark junction falls back to all-way-stop control; the lit junctions keep their own controller. Cars and queues are untouched at every switch, so a queue built up in stage 1 carries into stage 2, and stage 2's into the restore. The segmented tables split the dark time into stage 1 and stage 2; "Post" starts at the final restore.`,
        `Zones (the load-shedding scopes, ${zoneRefs}): zone 1 south, zone 2 middle, zone 3 north - groups of horizontal roads, read from the layout's own zone fields. A junction takes its horizontal road's zone, so a roundabout or all-way stop follows its road too; Mall Road (zone 1) has no signals to go dark. Vertical roads (${VERTICAL_ROADS}) carry no zone.`,
        `Zone wait is charged by junction (${stamp?.zoneAccounting ?? 'by-junction-v1'}): a car's wait goes to the zone of the junction it is queuing for - the junction at the end of its lane, or the one it is in. So Jan Shoba's queue at a zone 2 junction is zone 2 wait. This is unlike the total, main-arterial and side-street scopes, which are charged by road. A trip through several zones is in each, with only the wait it built up there, so the zone scopes overlap and don't sum to the total. Normal-power rows carry the zone figures too, as their baselines.`,
        `Recovery: the total, main-arterial and side-street scopes are timed from the FINAL restore (minute ${minute(restoreSeconds(data, 'rolling_blackout', SCOPES[0]) ?? 2700)} under load shedding); each zone from its own restore. Zones 1 and 3 come back while zone 2 is still dark next to them, so their recovery includes spillback from zone 2 and is not comparable to total-blackout recovery.`,
        `Post-restore windows - from the restore to the end of the ${measured}-minute window, and also the wait-recovery caps: ${capMin('load_shedding', 'total', stamp?.postRestoreWindowS ?? 3600)} min for the total blackout and for load-shedding zones 1 and 3; ${capMin('rolling_blackout', 'zone2', 2700)} min for load-shedding zone 2 and the load-shedding total, main-arterial and side-street scopes. The caps differ because each is the whole time left after its own restore - one shared cap would cut the total blackout short or run past the end of the load-shedding window. So recovery figures compare controllers within a section only, never across sections: a capped mean under a 60-minute cap and one under 45 minutes are not on the same scale.`,
        'Outage window card on the cover: "Total" is the total blackout\'s dark minutes; "Load shedding Z1+3 15–30, Z2 30–45" reads zones 1 and 3 dark minutes 15-30, then zone 2 dark minutes 30-45 - minutes into the measured window.',
        'Paired comparisons put each ITS variant against Webster-timed fixed-time control on the same seeds and power state, so each outage section carries its own normal-power baseline rows. Wait and recovery deltas: negative is better. Throughput and cleared-without-stopping deltas: positive is better.',
        '± figures are 95% confidence half-widths with Student\'s t on n - 1 degrees of freedom (t x sample stddev / sqrt(n)): in the comparison tables on the per-seed differences against fixed-time, in the per-condition tables on each condition\'s own mean. Deltas come from the unrounded paired values, so they can differ by a few tenths from a % change worked out from the rounded means shown.',
        'Recovery time is how long, after power returns, a metric takes to sustain its way back to its pre-cut level. Where both sides recover throughput within 30 s, its delta is shown in seconds rather than as a % of a few seconds. "Did not recover" means it never did within the measured window - a real result, not missing data. Read it alongside the post-recovery steady state in the segmented table.',
        `Mean recovery times only average the runs that DID recover, so every recovery figure carries its recovered/runs count. A recovery delta is only computed when both sides recovered in at least ${minRecoveredRuns} runs; below that it reads "too few runs" rather than a percentage built on a handful of outliers.`,
        'Wait recovery is mostly cut off by the end of the measured window, so it is reported as the share of runs that recovered within it, plus a capped mean that counts every run that never recovered at its scope\'s full post-restore window - a floor on the true mean that understates the gap. Throughput recovery carries little: restored junctions discharge their queues at saturation flow, so throughput is back within seconds for every controller - and under load shedding it is already above its pre-cut level at the final restore (stage 2 surge), so it reads 0 s. Read wait recovery and the post-recovery segments instead.',
        `Coordination (section ${SECTION.coordination}): Jan Shoba's route crosses all three zones, so in every load-shedding stage part of it is dark. Its married share is shown per stage; its route cycle only before the first cut and after the last restore - during the stages a mean cycle over the lit remainder means nothing ("—"). Load shedding fires the resync hold twice, once per restore.`,
        `Scope numbers are only comparable between batches with the same wait accounting (in the batch line on the cover).`,
        `The wait-time distribution: P95 and max per scope, the median for the total and zone scopes only; a scope's figures are over the same per-vehicle waits its mean counts. Median, P95 and "Max, run mean" average each run's own figure over the condition's runs; "Max, worst run" is the single longest wait in any of them. Runs from batches before this was recorded have no per-scope P95/max (n/a).`,
        ...thresholdNotes(data),
        ...sensorNotes(),
    ].forEach((note) => report.paragraph(`•  ${note}`));
}

/**
 * Builds and downloads the report.
 *
 * @param {object} data the results page's live `#results-data` payload
 * @param {{corridorId: string, corridorName: string, corridorUrl: ?string}} corridor
 *   `corridorUrl` is null for "All corridors" - no single layout to draw then.
 */
/**
 * e.g. results-hatfield-realistic-2026-10-03-2130-794f8bf-dirty.pdf - named for the batch it
 * reports (its start time and code), so two PDFs can't be mistaken for the same dataset.
 */
function reportFileName(corridorId, stamp, now) {
    const at = stamp?.startedAt ? new Date(stamp.startedAt) : now;
    const pad = (n) => String(n).padStart(2, '0');
    const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
    const treeState = { unchecked: '-dev', unknown: '-unknown', dirty: '-dirty' }[stamp?.treeState] ?? '';
    const code = stamp?.commit ? `-${stamp.commit}${treeState}` : '-unstamped';
    const routing = stamp?.routingMode === 'destination' ? '-destination' : '';
    return `results-${corridorId || 'all-corridors'}-${when}${code}${routing}.pdf`;
}

export async function exportResultsPdf(data, { corridorId, corridorName, corridorUrl }) {
    // A layout that fails to load or draw just leaves the cover without it.
    const corridorLayout = corridorUrl ? await corridorLayoutImage(corridorUrl).catch(() => null) : null;

    const pageTheme = currentTheme();
    applyChartTheme('light');

    try {
        const now = new Date();
        const report = new Report({
            corridorName,
            generatedAt: now.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
        });
        const variants = buildVariants(data);

        drawCover(report, data, variants, corridorLayout);
        drawOutageSection(report, data, variants, 'load_shedding');
        drawOutageSection(report, data, variants, 'rolling_blackout');
        report.newPage();
        drawCoordination(report, data, data.coordinationMetrics, SECTION.coordination);
        report.newPage();
        drawMethodNotes(report, data, SECTION.methodNotes);

        report.stampPages();
        report.doc.save(reportFileName(corridorId, data.batchStamp, now));
    } finally {
        applyChartTheme(pageTheme);
    }
}
