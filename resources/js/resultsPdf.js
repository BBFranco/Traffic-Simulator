/**
 * "Export PDF" report for /results - lazy-loaded by results.js so jsPDF stays out of the
 * page's main bundle.
 *
 * Unlike the on-screen dashboard, which shows ONE scope and ONE adaptive comparison target
 * at a time, the report spells out every combination the payload already carries: all three
 * scopes (Total / Main arterial / Side streets), and every controller variant side by side -
 * fixed-time, the blended adaptive average, each adaptive sensor on its own, and green wave.
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
import { buildLayout } from './sim/corridor.js';
import { LayoutRenderer, setRendererTheme } from './sim/renderer.js';

const SCOPES = [
    { key: 'total', suffix: '', label: 'Total', description: 'Main arterial + side streets combined' },
    { key: 'arterial', suffix: '_arterial', label: 'Main arterial', description: 'Traffic on the main arterial only' },
    { key: 'side_street', suffix: '_side_street', label: 'Side streets', description: 'Traffic on the cross streets only' },
];

const SENSOR_ORDER = ['inductive_loop', 'radar', 'camera', 'magnetometer'];

// Adaptive keeps its violet family so every sensor still reads as "adaptive" next to the
// orange fixed-time baseline and green-wave's green.
const SENSOR_COLOURS = {
    inductive_loop: '#5b21b6',
    radar: '#a78bfa',
    camera: '#c026d3',
    magnetometer: '#6366f1',
};

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
/** Wait recovery as the share of runs that recovered within the window, then the capped mean. */
const fmtWaitRecovery = (row, metric, windowS) => {
    const recovered = row[`${metric}_recovered`];
    const capped = cappedRecoveryS(row[metric], recovered, row.runs, windowS);
    return `${Math.round((recovered / row.runs) * 100)}% recovered (${recovered}/${row.runs})${capped == null ? '' : `
capped mean ${Math.round(capped)} s`}`;
};

/**
 * Every controller variant the report compares, in a fixed order - baseline first. `row(power)`
 * resolves the aggregate row, `seriesKeys` the recovery-timeline curves behind it (several for
 * the blended adaptive average, which has no single stored curve).
 */
function buildVariants(data) {
    const byKey = new Map(data.aggregates.map((row) => [`${row.controller_mode}|${row.power_state}`, row]));
    const bySensor = new Map(
        data.aggregatesBySensor
            .filter((row) => row.controller_mode === 'adaptive' && row.sensor_mode)
            .map((row) => [`${row.sensor_mode}|${row.power_state}`, row])
    );
    const sensors = SENSOR_ORDER.filter((sensor) => data.powerStates.some((power) => bySensor.has(`${sensor}|${power}`)));
    const adaptiveSeriesKeys = Object.keys(data.recoveryTimeline?.series ?? {}).filter((key) => key.startsWith('adaptive|'));

    const variants = [
        { id: 'fixed|', mode: 'fixed', sensor: null, label: 'Fixed-time', colour: MODE_COLOURS.fixed, row: (p) => byKey.get(`fixed|${p}`), seriesKeys: ['fixed|'] },
        { id: 'adaptive|average', mode: 'adaptive', sensor: 'average', label: 'Adaptive (avg. of sensors)', colour: MODE_COLOURS.adaptive, row: (p) => byKey.get(`adaptive|${p}`), seriesKeys: adaptiveSeriesKeys },
        ...sensors.map((sensor) => ({
            id: `adaptive|${sensor}`,
            mode: 'adaptive',
            sensor,
            label: `Adaptive - ${SENSOR_LABELS[sensor] ?? sensor}`,
            colour: SENSOR_COLOURS[sensor] ?? MODE_COLOURS.adaptive,
            row: (p) => bySensor.get(`${sensor}|${p}`),
            seriesKeys: [`adaptive|${sensor}`],
        })),
        { id: 'green_wave|', mode: 'green_wave', sensor: null, label: 'Green wave', colour: MODE_COLOURS.green_wave, row: (p) => byKey.get(`green_wave|${p}`), seriesKeys: ['green_wave|'] },
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
 * straight corridor doesn't render as a thin strip. Null when it can't be drawn.
 */
async function corridorLayoutImage(corridorUrl) {
    const response = await fetch(corridorUrl, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const layout = buildLayout(await response.json());

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
        new LayoutRenderer(canvas, { pixelRatio: 2 }).setLayout(layout);
        return {
            image: canvas.toDataURL('image/png'),
            aspect,
            ...corridorCounts(layout),
        };
    } finally {
        setRendererTheme(currentTheme());
        host.remove();
    }
}

/**
 * Roads counted by measurement scope (an arterial object with scope "side" is a side street, a
 * connector with scope "arterial" is an arterial), by distinct name - a road split into pieces at
 * its junctions (Jan Shoba, Arcadia, South) is still one road. Junctions are counted by control.
 */
function corridorCounts(layout) {
    const arterialNames = new Set();
    const sideNames = new Set();
    for (const arterial of layout.arterials) (arterial.scope === 'side' ? sideNames : arterialNames).add(arterial.shortName ?? arterial.name);
    for (const connector of layout.connectors) (connector.scope === 'arterial' ? arterialNames : sideNames).add(connector.name);
    for (const name of arterialNames) sideNames.delete(name);
    const nodes = layout.arterials.flatMap((arterial) => arterial.intersections);
    const countControl = (control) => nodes.filter((node) => node.control === control).length;
    return {
        arterialRoads: arterialNames.size,
        sideRoads: sideNames.size,
        signals: countControl('signal'),
        roundabouts: countControl('roundabout'),
        allWayStops: countControl('allWayStop'),
    };
}

const printLegend = {
    display: true,
    position: 'bottom',
    labels: { boxWidth: 10, boxHeight: 10, padding: 10, color: '#0f172a', font: { size: 10 } },
};

function barChartImage(data, variants, metric, { unit, tickSuffix = '' }) {
    const options = baseOptions({ tickFormat: (v) => `${v}${tickSuffix}` });

    return renderChartImage(
        {
            type: 'bar',
            data: {
                labels: data.powerStates.map((p) => POWER_LABELS[p] ?? p),
                datasets: variants.map((variant) =>
                    barDataset({
                        label: variant.label,
                        colour: variant.colour,
                        data: data.powerStates.map((power) => one(variant.row(power)?.[metric] ?? null)),
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
    const curves = variant.seriesKeys.map((key) => timeline.series[key]?.[metricKey]).filter(Boolean);
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

function recoveryLineImage(data, variants, metricKey) {
    const timeline = data.recoveryTimeline;
    if (!timeline?.seconds?.length) return null;

    const datasets = variants
        .map((variant) => ({ variant, series: recoverySeries(timeline, variant, metricKey) }))
        .filter(({ series }) => series)
        .map(({ variant, series }) => ({ ...lineDataset({ label: variant.label, colour: variant.colour, data: series }), borderWidth: 1.6 }));
    if (!datasets.length) return null;

    const options = baseOptions({ xTitle: 'seconds into run' });
    const hasBand = timeline.sheddingStart != null && timeline.sheddingEnd != null;

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
                    ...(hasBand
                        ? {
                              xRangeBand: {
                                  from: nearestIndex(timeline.seconds, timeline.sheddingStart),
                                  to: nearestIndex(timeline.seconds, timeline.sheddingEnd),
                                  label: 'LIGHTS DARK',
                              },
                          }
                        : {}),
                },
            },
            plugins: [xRangeBand],
        },
        760,
        300
    );
}

/** Horizontal time-to-recovery bars, one per variant that actually recovered in the window. */
function recoveryTimeImage(variants, metric) {
    const measured = variants.filter((variant) => variant.row('load_shedding')?.[metric] != null);
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
                    const row = variant.row('load_shedding');
                    return [variant.label, `${row[`${metric}_recovered`]}/${row.runs} recovered`];
                }),
                datasets: [
                    {
                        data: measured.map((variant) => one(variant.row('load_shedding')[metric])),
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
    }

    newPage() {
        this.doc.addPage();
        this.y = TOP;
    }

    ensureSpace(height) {
        if (this.y + height > BOTTOM) this.newPage();
    }

    sectionTitle(title, subtitle) {
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

    heading(title, caption) {
        const { doc } = this;
        const captionLines = caption ? doc.setFontSize(8).splitTextToSize(caption, CONTENT_WIDTH) : [];
        this.ensureSpace(10 + captionLines.length * 3.6 + 20);
        doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...COLOURS.ink);
        doc.text(title, PAGE.margin, this.y + 4);
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
    doc.text(`Generated ${meta.generatedAt}`, PAGE.margin, 56);


    const totalRuns = data.aggregates.reduce((sum, row) => sum + row.runs, 0);
    const conditions = data.aggregatesBySensor.length;
    const timeline = data.recoveryTimeline;
    const stats = [
        ['Batch runs', totalRuns.toLocaleString()],
        ['Conditions', String(conditions)],
        ['Reps / condition', conditions ? String(Math.round(totalRuns / conditions)) : 'n/a'],
        ['Outage window', timeline?.sheddingStart != null ? `${Math.round(timeline.sheddingStart)}-${Math.round(timeline.sheddingEnd)} s` : 'n/a'],
        ['Warm-up', data.batchWarmupLabel ?? 'n/a'],
    ];

    if (data.batchStamp?.label) {
        doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(...COLOURS.muted);
        doc.text(doc.splitTextToSize(`Batch: ${data.batchStamp.label}`, CONTENT_WIDTH).slice(0, 2), PAGE.margin, 67.5);
    }

    const boxWidth = (CONTENT_WIDTH - (stats.length - 1) * 4) / stats.length;
    stats.forEach(([label, value], i) => {
        const x = PAGE.margin + i * (boxWidth + 4);
        doc.setFillColor(...COLOURS.headFill).setDrawColor(...COLOURS.rule);
        doc.roundedRect(x, 74, boxWidth, 20, 2, 2, 'FD');
        doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(...COLOURS.muted);
        doc.text(label.toUpperCase(), x + 3, 80);
        doc.setFont('helvetica', 'bold').setFontSize(14).setTextColor(...COLOURS.ink);
        doc.text(value, x + 3, 89);
    });

    report.y = 102;
    if (data.hasNonStationaryBatch) {
        doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(...COLOURS.worseText);
        const warning = doc.splitTextToSize(
            'Baseline not stationary: the warm-up probe found a controller whose waits were still growing after the longest warm-up, so this batch was capped at that maximum. Its steady-state figures describe a system that is still drifting.',
            CONTENT_WIDTH
        );
        doc.text(warning, PAGE.margin, report.y);
        report.y += warning.length * 3.6 + 3;
    }
    if (corridorLayout) {
        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        report.chartCard(
            'Corridor layout',
            [
                plural(corridorLayout.arterialRoads, 'arterial road'),
                plural(corridorLayout.sideRoads, 'side street'),
                plural(corridorLayout.signals, 'signalised junction'),
                corridorLayout.roundabouts && plural(corridorLayout.roundabouts, 'roundabout'),
                corridorLayout.allWayStops && plural(corridorLayout.allWayStops, 'all-way stop'),
            ].filter(Boolean).join(' · '),
            corridorLayout.image,
            corridorLayout.aspect
        );
    }

    report.heading('Controller variants in this report', 'Colour follows the variant on every chart. Adaptive is broken out per sensor model as well as the blended average across sensors.');
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
        'Paired against Webster-timed fixed-time control on the same seeds; ± is the 95% CI on the per-seed differences. Wait (mean, median, P95): negative is better. Throughput and cleared-without-stopping: positive is better. Every sensor on its own follows in section 1.'
    );
    comparisonTable(report, data, variants, SCOPES[0], { compact: true });
}

/** Comparison target order: blended adaptive, each sensor, then green wave. */
function comparisonRows(data, variants, scope) {
    const rank = new Map(variants.map((variant, i) => [variant.id, i]));
    return (data.pairedComparisons ?? [])
        .filter((c) => c.scope === scope.key)
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
    if (c.power_state !== 'load_shedding') return '-';
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

    return reliable ? `${fmtDelta(delta, '%')}\n${counts}` : `too few runs\n${counts}`;
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

function comparisonTable(report, data, variants, scope, { compact = false } = {}) {
    // The cover's compact headline keeps to the blended adaptive average and green wave.
    const rows = comparisonRows(data, variants, scope).filter((c) => !compact || c.variant.sensor === null || c.variant.sensor === 'average');
    if (!rows.length) {
        report.paragraph('No paired comparisons yet - run the batch for this corridor first.');
        return;
    }

    const columns = [
        { header: 'ITS variant', value: (c) => c.variant.label },
        { header: 'Power', value: (c) => POWER_LABELS[c.power_state] ?? c.power_state },
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
        ...(compact
            ? []
            : [
                  // Throughput-recovery first: wait-recovery is mostly censored by the measured window.
                  { header: 'Recovery (thru)', value: (c) => fmtRecoveryDelta(c, 'throughput'), improves: 'recovery_improves' },
                  {
                      header: 'Recovery (wait)',
                      value: (c) => fmtRecoveryDelta(c, 'wait', data.batchStamp?.postRestoreWindowS),
                      improves: (c) => (c.power_state === 'load_shedding' ? c.recovery_wait_recovered / c.runs > c.baseline_recovery_wait_recovered / c.baseline_runs : null),
                  },
                  { header: 'Runs (ITS / fixed)', value: (c) => `${c.runs} / ${c.baseline_runs}` },
              ]),
    ];

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

function perConditionTable(report, data, variants, scope) {
    const m = (metric) => `${metric}${scope.suffix}`;
    const body = [];
    variants.forEach((variant) => {
        data.powerStates.forEach((power) => {
            const row = variant.row(power);
            if (!row) return;
            body.push([
                variant.label,
                POWER_LABELS[power] ?? power,
                String(row.runs),
                fmtCi(row[m('avg_wait_time')], row[`${m('avg_wait_time')}_ci95`]),
                fmtCi(row[m('throughput_per_min')], row[`${m('throughput_per_min')}_ci95`]),
                fmtCi(row[m('pct_cleared_without_stop')], row[`${m('pct_cleared_without_stop')}_ci95`]),
                power === 'load_shedding' ? fmtRecovery(row, m('time_to_recovery_seconds')) : '-',
                power === 'load_shedding' ? fmtWaitRecovery(row, m('time_to_recovery_wait_seconds'), data.batchStamp?.postRestoreWindowS) : '-',
            ]);
        });
    });

    report.table({
        head: [['Variant', 'Power', 'Runs', 'Avg wait (s)', 'Throughput (/min)', 'Cleared w/o stop (%)', 'Recovery - thru', 'Recovery - wait']],
        body,
        columnStyles: { 0: { cellWidth: 38 }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' } },
    });
}

function segmentedTable(report, variants, scope) {
    const m = (metric) => `${metric}${scope.suffix}`;
    const body = variants
        .map((variant) => ({ variant, row: variant.row('load_shedding') }))
        .filter(({ row }) => row)
        .map(({ variant, row }) => [
            variant.label,
            fmt(row[m('avg_wait_time_pre_outage')]),
            fmt(row[m('avg_wait_time_during_outage')]),
            fmt(row[m('avg_wait_time_post_recovery')]),
            fmt(row[m('throughput_per_min_pre_outage')]),
            fmt(row[m('throughput_per_min_during_outage')]),
            fmt(row[m('throughput_per_min_post_recovery')]),
        ]);
    if (!body.length) {
        report.paragraph('No load-shedding runs for this corridor yet.');
        return;
    }

    report.table({
        head: [
            [
                { content: 'Variant', rowSpan: 2 },
                { content: 'Avg wait (s)', colSpan: 3, styles: { halign: 'center' } },
                { content: 'Throughput (/min)', colSpan: 3, styles: { halign: 'center' } },
            ],
            ['Pre-outage', 'During', 'Post-recovery', 'Pre-outage', 'During', 'Post-recovery'].map((content) => ({ content, styles: { halign: 'right' } })),
        ],
        body,
        columnStyles: { 0: { cellWidth: 44 }, 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' } },
    });
}

function distributionTable(report, data, variants) {
    const body = [];
    variants.forEach((variant) => {
        data.powerStates.forEach((power) => {
            const row = variant.row(power);
            if (!row) return;
            body.push([variant.label, POWER_LABELS[power] ?? power, fmt(row.avg_wait_time), fmt(row.median_wait_time), fmt(row.p95_wait_time), fmt(row.max_wait_time)]);
        });
    });

    report.table({
        head: [['Variant', 'Power', 'Mean (s)', 'Median (s)', 'P95 (s)', 'Max (s)']],
        body,
        columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    });
}

function drawScope(report, data, variants, scope, index) {
    const m = (metric) => `${metric}${scope.suffix}`;
    report.newPage();
    report.sectionTitle(`${index + 1}. ${scope.label}`, scope.description);

    report.heading('Every ITS variant vs fixed-time', 'Percentage change against fixed-time on the same seeds and power state; ± is the 95% CI on the per-seed differences. Green = improvement, red = regression. Recovery: throughput first - wait-recovery is often cut off by the end of the measured window.');
    comparisonTable(report, data, variants, scope);

    const barAspect = 270 / 760;
    report.chartCard('Average wait time', 'seconds per vehicle · lower is better', barChartImage(data, variants, m('avg_wait_time'), { unit: '', tickSuffix: 's' }), barAspect);
    report.chartCard('Throughput', 'vehicles cleared per minute · higher is better', barChartImage(data, variants, m('throughput_per_min'), { unit: '' }), barAspect);
    report.chartCard('Cleared without stopping', '% of vehicles · higher is better', barChartImage(data, variants, m('pct_cleared_without_stop'), { unit: '', tickSuffix: '%' }), barAspect);

    report.heading('Per-condition means', 'Mean across reps, ± 95% confidence half-width on that condition\'s own mean. Recovery = seconds after power returns until the metric is back to its pre-cut level.');
    perConditionTable(report, data, variants, scope);

    report.heading(
        'Load shedding, segmented',
        'Pre-outage / during-outage / post-recovery averages from cumulative counters. During the outage every controller runs the same all-way-stop control, but each carries in the queue it had when the power went - so the during-outage figures still differ by controller.'
    );
    segmentedTable(report, variants, scope);

    const lineAspect = 300 / 760;
    const waitLine = recoveryLineImage(data, variants, m('avg_wait_time'));
    const thruLine = recoveryLineImage(data, variants, m('throughput_per_min'));
    if (waitLine) report.chartCard('Recovery after a power cut - wait time', 'average wait, s per vehicle · shaded band = outage window, power restored at its right edge', waitLine, lineAspect);
    if (thruLine) report.chartCard('Recovery after a power cut - throughput', 'vehicles cleared per minute · shaded band = outage window, power restored at its right edge', thruLine, lineAspect);

    drawRecoveryTimes(report, variants, scope);
}

/** The two time-to-recovery bar charts side by side. */
function drawRecoveryTimes(report, variants, scope) {
    const charts = [
        { title: 'Time to recovery - wait time', metric: `time_to_recovery_wait_seconds${scope.suffix}` },
        { title: 'Time to recovery - throughput', metric: `time_to_recovery_seconds${scope.suffix}` },
    ].map((chart) => {
        const loadShedding = variants.filter((v) => v.row('load_shedding'));
        const measured = loadShedding.filter((v) => v.row('load_shedding')[chart.metric] != null);
        return { ...chart, image: recoveryTimeImage(variants, chart.metric), bars: measured.length, missing: loadShedding.filter((v) => !measured.includes(v)) };
    });
    if (!charts.some((chart) => chart.image)) return;

    const { doc } = report;
    const width = (CONTENT_WIDTH - 4) / 2;
    const heightFor = (bars) => (width - 4) * ((60 + bars * 38) / 380);
    const imageHeight = Math.max(...charts.map((chart) => heightFor(chart.bars)));
    report.ensureSpace(imageHeight + 22);
    const top = report.y;

    charts.forEach((chart, i) => {
        const x = PAGE.margin + i * (width + 4);
        doc.setDrawColor(...COLOURS.rule).setLineWidth(0.3);
        doc.roundedRect(x, top, width, imageHeight + 18, 2, 2, 'S');
        doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...COLOURS.ink);
        doc.text(chart.title, x + 3, top + 5.5);
        doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...COLOURS.muted);
        doc.text('seconds back to pre-cut level · lower is better · (recovered/runs)', x + 3, top + 9.5);
        if (chart.image) doc.addImage(chart.image, 'PNG', x + 2, top + 11, width - 4, heightFor(chart.bars), undefined, 'FAST');
        if (chart.missing.length) {
            doc.setFontSize(7).setTextColor(...COLOURS.worseText);
            doc.text(doc.splitTextToSize(`Did not recover in window: ${chart.missing.map((v) => v.label).join(', ')}`, width - 6), x + 3, top + imageHeight + 12);
        }
    });
    report.y = top + imageHeight + 22;
}

function drawMethodNotes(report, data) {
    const minRecoveredRuns = data.minRecoveredRuns ?? 10;
    // The warm-up is measured per batch by the probe (sim/warmupProbe.js) and stored on each run.
    const warmup = data.batchWarmupLabel
        ? `a ${data.batchWarmupLabel} warm-up, measured for this batch by the warm-up probe${data.hasNonStationaryBatch ? ' (capped at its maximum: at least one controller never settled)' : ''},`
        : 'a warm-up (not recorded for this batch)';
    report.sectionTitle('Method notes');
    [
        `Every condition (controller mode x power state, with adaptive further split by sensor model) gets 30 seeded repetitions per batch; the Runs columns show how many are pooled into each figure here. Each run discards ${warmup} before measuring ${data.batchStamp?.measuredMinutes ?? 40} simulated minutes at dt = 0.1 s.`,
        `Wait accounting: ${data.batchStamp?.waitAccounting ?? 'not recorded'}. The total scope counts every vehicle once with its whole trip's wait; Main arterial and Side streets each count every vehicle that used them, with only the wait it built up on their roads - so a trip over both is in both, and the two don't add up to the total.`,
        'Load-shedding conditions cut power a quarter of the way into the measured window and restore it at the halfway mark. While the lights are dark every controller falls back to all-way-stop behaviour.',
        'Paired comparisons put each ITS variant against Webster-timed fixed-time control on the same seeds and power state. Wait and recovery deltas: negative is better. Throughput and cleared-without-stopping deltas: positive is better.',
        '± figures are 95% confidence half-widths with Student\'s t on n - 1 degrees of freedom (t x sample stddev / sqrt(n)): in the comparison tables on the per-seed differences against fixed-time, in the per-condition tables on each condition\'s own mean. Deltas come from the unrounded paired values, so they can differ by a few tenths from a % change worked out from the rounded means shown.',
        'Recovery time is how long, after power returns, a metric takes to sustain its way back to its pre-cut level. "Did not recover" means it never did within the measured window - a real result, not missing data. Read it alongside the post-recovery steady state in the segmented table.',
        `Mean recovery times only average the runs that DID recover, so every recovery figure carries its recovered/runs count. A recovery delta is only computed when both sides recovered in at least ${minRecoveredRuns} runs; below that it reads "too few runs" rather than a percentage built on a handful of outliers.`,
        `Wait recovery is mostly cut off by the end of the measured window, so it is reported as the share of runs that recovered within it, plus a capped mean that counts every run that never recovered at the full ${data.batchStamp?.postRestoreWindowS ?? '-'} s after power returned - a floor on the true mean that understates the gap. Throughput recovery is the primary recovery figure.`,
        `Scope numbers are only comparable between batches with the same wait accounting (in the batch line on the cover).`,
        'The wait-time distribution (median / P95 / max) is recorded for the total scope only.',
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
 * Appendix: the latest sensitivity batch (different signal-timing rules) against the main batch
 * on the same seeds. The headline above always stays on the main batch.
 */
function drawSensitivityAppendix(report, appendix) {
    report.newPage();
    report.sectionTitle('Appendix - Webster turn-weight sensitivity', appendix.label);
    report.paragraph(
        "The main batch times protected turns on real q; a turn stage's weight only raises its minimum green. This batch also scales the turn q by its weight before Webster, for fixed-time and green wave alike. Fixed-time runs each junction on its own cycle, so only the two weighted junctions lengthen theirs (by about 5 s). Green wave runs a whole arterial on one common cycle and squeezes each junction's minimum greens inside it, where fixed-time adds them on top - on Lynnwood the pure-q common cycle (81 s) is shorter than fixed-time's own cycle at Lynnwood / Duxbury (92 s), and the weight lifts it to 92 s. Read this as a green-wave cycle-length effect, not as green wave against a weaker baseline: weighted fixed-time is no faster than the main batch's."
    );
    const controllerLabel = { fixed: 'Fixed-time', green_wave: 'Green wave', adaptive: 'Adaptive - Inductive loop' };
    report.table({
        head: [['Controller', 'Wait', 'Runs', 'Sensitivity (s)', 'Main, same seeds (s)', 'Sensitivity vs main']],
        body: appendix.rows.map((row) => [
            `${controllerLabel[row.controller_mode] ?? row.controller_mode} · ${POWER_LABELS[row.power_state] ?? row.power_state}`,
            row.metric,
            String(row.runs),
            fmt(row.sensitivity),
            fmt(row.main_same_seeds),
            row.vs_main ? fmtPaired(row.vs_main.delta, row.vs_main.ci95, '%') : 'n/a',
        ]),
        columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    });
    const fmtGw = (d) => (d ? `${fmtDelta(d.delta, '%')} ±${d.ci95.toFixed(1)} (${d.pairs} seeds)` : 'n/a');
    report.table({
        head: [['Green wave vs fixed-time', 'Main batch (pure q)', 'Sensitivity (q x weight)']],
        body: appendix.greenWaveVsFixed.map((row) => [row.metric, fmtGw(row.main), fmtGw(row.sensitivity)]),
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
    });
    report.paragraph('± is the 95% CI on the per-seed differences. An interval that spans zero means no measurable difference at this many seeds.');
}

/**
 * e.g. results-hatfield-realistic-2026-10-03-2130-794f8bf-dirty.pdf - named for the batch it
 * reports (its start time and code), so two PDFs can't be mistaken for the same dataset.
 */
function reportFileName(corridorId, stamp, now) {
    const at = stamp?.startedAt ? new Date(stamp.startedAt) : now;
    const pad = (n) => String(n).padStart(2, '0');
    const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
    const code = stamp?.commit ? `-${stamp.commit}${stamp.dirty ? '-dirty' : ''}` : '-unstamped';
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
        SCOPES.forEach((scope, index) => drawScope(report, data, variants, scope, index));

        report.newPage();
        report.sectionTitle(`${SCOPES.length + 1}. Wait-time distribution`, 'Total scope - a mean alone can\'t tell "everyone waits a bit longer" apart from "a few are stranded"');
        distributionTable(report, data, variants);
        drawMethodNotes(report, data);
        if (data.sensitivityAppendix) drawSensitivityAppendix(report, data.sensitivityAppendix);

        report.stampPages();
        report.doc.save(reportFileName(corridorId, data.batchStamp, now));
    } finally {
        applyChartTheme(pageTheme);
    }
}
