/**
 * Shared Chart.js theme for the simulator footer and the results dashboard.
 *
 * SERIES COLOURS ARE THE SAME IN BOTH THEMES, and that is a checked result rather
 * than a shortcut: every slot below was validated against a white surface AND
 * against the dark surface (#0f172a), and passes in both - inside the lightness
 * band for each mode, over the chroma floor, at least 3:1 on the surface, worst
 * adjacent pair separating by dE >= 10 under simulated protanopia/deuteranopia/
 * tritanopia. Holding them steady means an entity does not change colour when the
 * user flips the theme. Do not shift these to Tailwind's 400 steps without
 * re-running `validate_palette.js` - the 400s fall outside the dark band.
 *
 * What DOES switch per theme is the ink: text, gridlines, axis and surface.
 *
 * Two rules the rest of the code relies on:
 *   1. Colour follows the entity, never its rank. A controller mode keeps its hue
 *      whatever else is on the chart, so filtering never repaints the survivors.
 *   2. Marks carry colour; text carries text tokens. A value label is never
 *      painted in its series colour.
 */

import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);

const INKS = {
    light: {
        primary: '#0f172a',
        secondary: '#475569',
        muted: '#64748b',
        grid: 'rgba(100, 116, 139, 0.18)',
        axis: 'rgba(100, 116, 139, 0.30)',
        surface: '#ffffff',
        surfaceRaised: '#f1f5f9',
        tooltipBg: 'rgba(15, 23, 42, 0.94)',
        tooltipBorder: 'rgba(148, 163, 184, 0.35)',
        tooltipText: '#f8fafc',
        bandFill: 'rgba(225, 29, 72, 0.08)',
        bandStroke: 'rgba(225, 29, 72, 0.35)',
        bandLabel: 'rgba(159, 18, 57, 0.9)',
    },
    dark: {
        primary: '#e2e8f0',
        secondary: '#94a3b8',
        muted: '#64748b',
        grid: 'rgba(148, 163, 184, 0.13)',
        axis: 'rgba(148, 163, 184, 0.22)',
        surface: '#0f172a',
        surfaceRaised: '#1e293b',
        tooltipBg: 'rgba(2, 6, 15, 0.94)',
        tooltipBorder: 'rgba(148, 163, 184, 0.25)',
        tooltipText: '#e2e8f0',
        bandFill: 'rgba(244, 63, 94, 0.10)',
        bandStroke: 'rgba(244, 63, 94, 0.35)',
        bandLabel: 'rgba(253, 164, 175, 0.9)',
    },
};

/**
 * Active ink. This is a live ES module binding, so importers see the reassignment
 * without re-importing - but a chart already built holds its own copies, so pages
 * rebuild their charts after calling `applyChartTheme`.
 */
export let INK = INKS.light;

export function applyChartTheme(theme) {
    INK = INKS[theme] ?? INKS.light;
    Chart.defaults.color = INK.secondary;
    return INK;
}

/** Controller modes, in fixed slot order. Baseline first. */
export const MODE_COLOURS = {
    fixed: '#ea580c',
    adaptive: '#8b5cf6',
    green_wave: '#059669',
};

export const MODE_LABELS = {
    fixed: 'Fixed-time',
    adaptive: 'Adaptive',
    green_wave: 'Green wave',
};

export const POWER_LABELS = {
    normal: 'Normal power',
    load_shedding: 'Load shedding',
};

export const SENSOR_LABELS = {
    none: 'None (timer only)',
    inductive_loop: 'Inductive loop',
    radar: 'Radar',
    camera: 'Camera',
    magnetometer: 'Magnetometer',
};

Chart.defaults.font.family =
    "Figtree, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = INK.secondary;
Chart.defaults.animation.duration = 350;

/* -------------------------------------------------------------- base options */

/**
 * @param {object} opts
 * @param {string} [opts.yTitle]
 * @param {string} [opts.xTitle]
 * @param {(v: number) => string} [opts.tickFormat]
 * @param {(ctx: object) => string} [opts.tooltipLabel]
 * @param {boolean} [opts.beginAtZero]
 */
export function baseOptions({
    yTitle = '',
    xTitle = '',
    tickFormat = (v) => `${v}`,
    tooltipLabel = null,
    beginAtZero = true,
} = {}) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 18, right: 12, bottom: 2, left: 2 } },
        interaction: { mode: 'index', intersect: false },
        plugins: {
            // Every chart in this app renders its legend as HTML next to the
            // chart, so identity is available to a screen reader as text.
            legend: { display: false },
            tooltip: tooltipTheme(tooltipLabel),
        },
        scales: {
            x: {
                title: xTitle ? { display: true, text: xTitle, color: INK.muted } : { display: false },
                grid: { display: false },
                border: { color: INK.axis },
                ticks: { color: INK.secondary, maxRotation: 0, autoSkipPadding: 12 },
            },
            y: {
                beginAtZero,
                title: yTitle ? { display: true, text: yTitle, color: INK.muted } : { display: false },
                // Solid hairlines only - a dashed grid reads as a threshold.
                grid: { color: INK.grid, drawTicks: false },
                border: { display: false },
                ticks: { color: INK.secondary, padding: 8, callback: (v) => tickFormat(v) },
            },
        },
    };
}

function tooltipTheme(tooltipLabel) {
    return {
        backgroundColor: INK.tooltipBg,
        borderColor: INK.tooltipBorder,
        borderWidth: 1,
        titleColor: INK.tooltipText,
        bodyColor: INK.tooltipText,
        padding: 10,
        cornerRadius: 6,
        boxPadding: 5,
        usePointStyle: true,
        callbacks: tooltipLabel ? { label: tooltipLabel } : {},
    };
}

/** Grouped-bar dataset defaults: rounded data end, square baseline, real gaps. */
export function barDataset({ label, data, colour }) {
    return {
        label,
        data,
        backgroundColor: colour,
        hoverBackgroundColor: colour,
        borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
        borderSkipped: 'bottom',
        // Gaps rather than borders separate adjacent bars.
        categoryPercentage: 0.68,
        barPercentage: 0.84,
        maxBarThickness: 44,
    };
}

/** Thin line, generous hit radius, no marker clutter until hover. */
export function lineDataset({ label, data, colour, fill = false }) {
    return {
        label,
        data,
        borderColor: colour,
        backgroundColor: fill ? `${colour}22` : colour,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 14,
        pointBackgroundColor: colour,
        pointBorderColor: INK.surface,
        pointBorderWidth: 2,
        tension: 0.25,
        fill,
    };
}

/* -------------------------------------------------------------------plugins */

/**
 * Direct value labels above bars. Selective by construction: one label per bar,
 * skipped when the bar is too short to carry it clear of the baseline.
 */
export const barValueLabels = {
    id: 'barValueLabels',
    afterDatasetsDraw(chart, _args, opts) {
        const format = opts?.formatter ?? ((v) => (v === null ? '' : `${v}`));
        const { ctx } = chart;

        ctx.save();
        ctx.font = "600 10px Figtree, ui-sans-serif, system-ui, sans-serif";
        ctx.fillStyle = INK.secondary;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        chart.data.datasets.forEach((dataset, di) => {
            const meta = chart.getDatasetMeta(di);
            if (meta.hidden) return;
            meta.data.forEach((bar, i) => {
                const value = dataset.data[i];
                if (value === null || value === undefined) return;
                const height = bar.base - bar.y;
                if (height < 16) return;
                ctx.fillText(format(value), bar.x, bar.y - 4);
            });
        });
        ctx.restore();
    },
};

/**
 * Labels the final point of each line with its series name, so the lines are
 * identifiable without tracing back to the legend.
 */
export const lineEndLabels = {
    id: 'lineEndLabels',
    afterDatasetsDraw(chart, _args, opts) {
        const labelFor = opts?.labelFor ?? ((dataset) => dataset.label);
        const { ctx, chartArea } = chart;

        const placed = [];
        ctx.save();
        ctx.font = "600 10px Figtree, ui-sans-serif, system-ui, sans-serif";
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';

        chart.data.datasets.forEach((dataset, di) => {
            const meta = chart.getDatasetMeta(di);
            if (meta.hidden || meta.data.length === 0) return;
            const last = meta.data[meta.data.length - 1];

            // Nudge apart so two lines ending close together stay readable.
            let y = last.y;
            while (placed.some((p) => Math.abs(p - y) < 12)) y -= 12;
            placed.push(y);

            const text = labelFor(dataset, di);
            const x = Math.min(last.x + 8, chartArea.right - ctx.measureText(text).width - 2);

            ctx.fillStyle = dataset.borderColor;
            ctx.beginPath();
            ctx.arc(x - 4, y, 2.5, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = INK.primary;
            ctx.fillText(text, x + 2, y);
        });
        ctx.restore();
    },
};

/**
 * Shades an x-range - used to mark the window when the power was out. A filled
 * band, not dashed rules, so it does not read as a grid or a projection.
 *
 * `from`/`to` are CATEGORY INDICES, not axis values: on a category scale
 * `getPixelForValue` takes an index, so passing seconds would place the band far
 * off-canvas. Callers resolve the index from their label array.
 */
export const xRangeBand = {
    id: 'xRangeBand',
    beforeDatasetsDraw(chart, _args, opts) {
        if (!opts || opts.from === undefined || opts.to === undefined) return;
        if (opts.from < 0 || opts.to < 0) return;
        const { ctx, chartArea, scales } = chart;
        const x0 = scales.x.getPixelForValue(opts.from);
        const x1 = scales.x.getPixelForValue(opts.to);
        if (!Number.isFinite(x0) || !Number.isFinite(x1)) return;

        ctx.save();
        ctx.fillStyle = opts.fill ?? INK.bandFill;
        ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);

        ctx.strokeStyle = opts.stroke ?? INK.bandStroke;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, chartArea.top);
        ctx.lineTo(x0, chartArea.bottom);
        ctx.moveTo(x1, chartArea.top);
        ctx.lineTo(x1, chartArea.bottom);
        ctx.stroke();

        if (opts.label) {
            ctx.font = "600 9px Figtree, ui-sans-serif, system-ui, sans-serif";
            ctx.fillStyle = INK.bandLabel;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(opts.label, (x0 + x1) / 2, chartArea.top + 3);
        }
        ctx.restore();
    },
};

export { Chart };
