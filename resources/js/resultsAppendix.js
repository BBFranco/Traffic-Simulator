/**
 * The results report's appendix: detailed figures (A1-A9) and tables (A1-A10), recomputed from every run of the
 * batch shown - so after a new batch its numbers and figures can be read straight off the report instead of
 * re-running separate analysis scripts by hand.
 *
 * Every number: one value per run, paired by seed;
 * "Adaptive" / "Coordinated adaptive" without a sensor is the per-seed mean of the four sensors; ± is the 95% t
 * half-width; percentages are of the baseline's mean; wait recovery that never happened counts at the post-restore cap.
 * The figures use a fixed print palette and layout, independent of the app theme, so they can be reused as images.
 */
import { POWER_LABELS } from './charts/theme.js';
import { ci95, friedman, mean, median, paired } from './stats/pairedStats.js';

const SENSORS = ['inductive_loop', 'radar', 'camera', 'magnetometer'];
const POWERS = ['normal', 'load_shedding', 'rolling_blackout'];
const OUTAGE_POWERS = ['load_shedding', 'rolling_blackout'];
const CONTROLLERS = ['fixed', 'adaptive', 'green_wave', 'coordinated_adaptive'];
/** Wait-recovery caps (the post-restore windows) for batches whose stamp doesn't carry them. */
const FALLBACK_CAP_S = { load_shedding: 3600, rolling_blackout: 2700 };

const NAME = { fixed: 'Fixed-time', adaptive: 'Adaptive', green_wave: 'Green wave', coordinated_adaptive: 'Coordinated adaptive' };
const SHORT_NAME = { fixed: 'Fixed-time', adaptive: 'Adaptive', green_wave: 'Green wave', coordinated_adaptive: 'Coordinated' };
const SENSOR_NAME = { inductive_loop: 'Inductive loop', radar: 'Radar', camera: 'Camera', magnetometer: 'Magnetometer' };
const SENSOR_SHORT = { inductive_loop: 'loop', radar: 'radar', camera: 'camera', magnetometer: 'magnetometer' };
const POWER_SHORT = { normal: 'N', load_shedding: 'TB', rolling_blackout: 'LS' };

// Fixed print palette, not the app's - these figures are meant to be lifted out as standalone images.
const INK = '#0b0b0b';
const INK2 = '#52514e';
const GRID = '#e6e5e0';
const COLOUR = { fixed: '#2a78d6', adaptive: '#eb6834', green_wave: '#1baf7a', coordinated_adaptive: '#eda100' };
const SENSOR_COLOUR = { inductive_loop: '#2a78d6', radar: '#eb6834', camera: '#1baf7a', magnetometer: '#eda100' };
const SENSOR_MARKER = { inductive_loop: 'circle', radar: 'rect', camera: 'triangle', magnetometer: 'rectRot' };
const POWER_COLOUR = { normal: '#52514e', load_shedding: '#e34948', rolling_blackout: '#6250d6' };
const POWER_MARKER = { normal: 'circle', load_shedding: 'rect', rolling_blackout: 'triangle' };
const CONTROLLER_MARKER = { fixed: 'circle', adaptive: 'rect', green_wave: 'triangle', coordinated_adaptive: 'rectRot' };
const CONTROLLER_DASH = { fixed: [], adaptive: [6, 3], green_wave: [7, 3, 2, 3], coordinated_adaptive: [2, 3] };

/** The main roads of Figure A2 - road_waits ids on the Hatfield network. */
const MAIN_ROADS = [
    ['francisbaard', 'Francis Baard'],
    ['pretorius', 'Pretorius'],
    ['stanza', 'Stanza Bopape'],
    ['lynnwood', 'Lynnwood'],
    ['conn_jan_shoba', 'Jan Shoba (main)'],
    ['conn_jan_shoba_sb', 'Jan Shoba (SB)'],
];

/** Table rows with each sensor on its own, in report order. */
const VARIANT_ROWS = [
    ['fixed', null, 'Fixed-time'],
    ['green_wave', null, 'Green wave'],
    ...SENSORS.map((s) => ['adaptive', s, `Adaptive – ${SENSOR_SHORT[s]}`]),
    ...SENSORS.map((s) => ['coordinated_adaptive', s, `Coordinated – ${SENSOR_SHORT[s]}`]),
];
/** The four controllers, the actuated ones as their sensor mean. */
const CONTROLLER_ROWS = CONTROLLERS.map((c) => [c, sensorOf(c), NAME[c]]);

function sensorOf(controller) {
    return controller === 'adaptive' || controller === 'coordinated_adaptive' ? 'avg' : null;
}

const powerLabel = (power) => POWER_LABELS[power] ?? power;
const fixed = (v, digits) => (Number.isFinite(v) ? v.toFixed(digits) : 'n/a');
// jsPDF's built-in fonts are WinAnsi: no U+2212 minus, Greek letters or superscripts in table text.
const signed = (v, digits) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(digits)}` : 'n/a');
const fmtP = (p) => (!Number.isFinite(p) ? 'n/a' : p < 0.001 ? '<.001' : p.toFixed(3).replace(/^0/, ''));
const finite = (values) => values.filter(Number.isFinite);

/* ---------------------------------------------------------------------- data */

/** Per-seed vectors over the batch's runs, as analyse.py's vec(). */
function indexRuns(runs) {
    const byCondition = new Map();
    for (const run of runs) {
        const sensor = sensorOf(run.controller_mode) ? run.sensor_mode : '';
        const key = `${run.controller_mode}|${sensor}|${run.power_state}`;
        if (!byCondition.has(key)) byCondition.set(key, new Map());
        byCondition.get(key).set(run.seed, run);
    }
    const seeds = [...new Set(runs.map((run) => run.seed))].sort((a, b) => a - b);

    const valueOf = (controller, sensor, power, seed, get) => {
        const run = byCondition.get(`${controller}|${sensor ?? ''}|${power}`)?.get(seed);
        const value = run ? get(run) : null;
        return value == null ? NaN : Number(value);
    };

    /** `sensor` 'avg' is the four sensors' per-seed mean (NaN unless all four ran). */
    const vec = (controller, sensor, power, getter) => {
        const get = typeof getter === 'string' ? (run) => run[getter] : getter;
        return seeds.map((seed) =>
            sensor === 'avg' ? mean(SENSORS.map((s) => valueOf(controller, s, power, seed, get))) : valueOf(controller, sensor, power, seed, get)
        );
    };
    const has = (controller, sensor, power) =>
        sensor === 'avg' ? SENSORS.every((s) => byCondition.has(`${controller}|${s}|${power}`)) : byCondition.has(`${controller}|${sensor ?? ''}|${power}`);

    return { vec, has, seeds };
}

/** paired() over the seeds both sides have. */
function pairedOn(a, b) {
    const keep = a.map((v, i) => Number.isFinite(v) && Number.isFinite(b[i]));
    const left = a.filter((_, i) => keep[i]);
    const right = b.filter((_, i) => keep[i]);
    return left.length >= 3 ? paired(left, right) : null;
}

const meanOf = (values) => (finite(values).length ? mean(finite(values)) : NaN);
const ciOf = (values) => (finite(values).length >= 2 ? ci95(finite(values)) : NaN);

/* ---------------------------------------------------------------------- tables */

function tableCondMeans(d) {
    return VARIANT_ROWS.filter(([c, s]) => d.has(c, s, 'normal')).map(([c, s, label]) => [
        label,
        ...POWERS.map((p) => {
            const v = d.vec(c, s, p, 'avg_wait_time');
            return d.has(c, s, p) ? `${fixed(meanOf(v), 1)} ± ${fixed(ciOf(v), 1)}` : 'n/a';
        }),
        fixed(meanOf(d.vec(c, s, 'normal', 'pct_cleared_without_stop')), 1),
        fixed(meanOf(d.vec(c, s, 'normal', 'throughput_per_min')), 1),
    ]);
}

const SCOPE_KEYS = ['avg_wait_time', 'avg_wait_time_arterial', 'avg_wait_time_side_street'];

function tableVsFixed(d) {
    const rows = [];
    for (const p of POWERS) {
        for (const [c, s, label] of CONTROLLER_ROWS.slice(1)) {
            if (!d.has(c, s, p) || !d.has('fixed', null, p)) continue;
            const cells = SCOPE_KEYS.map((key) => {
                const base = d.vec('fixed', null, p, key);
                const st = pairedOn(d.vec(c, s, p, key), base);
                return st ? `${signed(st.diff, 2)} ± ${fixed(st.ci, 2)} (${signed((100 * st.diff) / st.meanB, 1)}%)` : 'n/a';
            });
            const total = pairedOn(d.vec(c, s, p, 'avg_wait_time'), d.vec('fixed', null, p, 'avg_wait_time'));
            rows.push([powerLabel(p), label, ...cells, total ? fixed(total.dz, 1) : 'n/a']);
        }
    }
    return rows;
}

function tableTails(d) {
    return CONTROLLER_ROWS.map(([c, s, label]) => [
        label,
        ...['median_wait_time', 'p95_wait_time', 'max_wait_time'].flatMap((key) => POWERS.map((p) => fixed(meanOf(d.vec(c, s, p, key)), 0))),
    ]);
}

function tableDegradation(d) {
    return CONTROLLER_ROWS.map(([c, s, label]) => {
        const normal = d.vec(c, s, 'normal', 'avg_wait_time');
        return [
            label,
            fixed(meanOf(normal), 1),
            ...OUTAGE_POWERS.map((p) => {
                const st = pairedOn(d.vec(c, s, p, 'avg_wait_time'), normal);
                return st ? `${signed(st.diff, 2)} ± ${fixed(st.ci, 2)} (${signed((100 * st.diff) / st.meanB, 0)}%)` : 'n/a';
            }),
        ];
    });
}

function tableDiD(d) {
    const rows = [];
    const fixedNormal = d.vec('fixed', null, 'normal', 'avg_wait_time');
    for (const [c, s, label] of [CONTROLLER_ROWS[1], CONTROLLER_ROWS[3], CONTROLLER_ROWS[2]]) {
        const gapNormal = d.vec(c, s, 'normal', 'avg_wait_time').map((v, i) => v - fixedNormal[i]);
        const relNormal = gapNormal.map((g, i) => (100 * g) / fixedNormal[i]);
        for (const p of OUTAGE_POWERS) {
            const fixedOutage = d.vec('fixed', null, p, 'avg_wait_time');
            const gapOutage = d.vec(c, s, p, 'avg_wait_time').map((v, i) => v - fixedOutage[i]);
            const relOutage = gapOutage.map((g, i) => (100 * g) / fixedOutage[i]);
            const abs = pairedOn(gapOutage, gapNormal);
            const rel = pairedOn(relOutage, relNormal);
            if (!abs || !rel) continue;
            rows.push([
                label.replace(' adaptive', ''),
                powerLabel(p),
                signed(meanOf(gapNormal), 2),
                signed(meanOf(gapOutage), 2),
                `${signed(abs.diff, 2)} ± ${fixed(abs.ci, 2)}`,
                fmtP(abs.p),
                signed(meanOf(relNormal), 1),
                signed(meanOf(relOutage), 1),
                `${signed(rel.diff, 1)} ± ${fixed(rel.ci, 1)}`,
                fmtP(rel.p),
            ]);
        }
    }
    return rows;
}

const SEGMENT_COLUMNS = [
    ['load_shedding', 'avg_wait_time_pre_outage', 'Pre-outage'],
    ['load_shedding', 'avg_wait_time_during_outage', 'Dark (TB)'],
    ['load_shedding', 'avg_wait_time_post_recovery', 'Post-restore (TB)'],
    ['rolling_blackout', 'avg_wait_time_stage1', 'Stage 1 (LS)'],
    ['rolling_blackout', 'avg_wait_time_stage2', 'Stage 2 (LS)'],
    ['rolling_blackout', 'avg_wait_time_post_recovery', 'Post-restore (LS)'],
];

function tableSegments(d) {
    return CONTROLLER_ROWS.map(([c, s, label]) => [label, ...SEGMENT_COLUMNS.map(([p, key]) => fixed(meanOf(d.vec(c, s, p, key)), 1))]);
}

function recoveryVec(d, c, s, p, capS) {
    return d.vec(c, s, p, (run) => (run.time_to_recovery_wait_seconds == null ? capS : run.time_to_recovery_wait_seconds));
}

function tableRecovery(d, capFor) {
    return VARIANT_ROWS.filter(([c, s]) => d.has(c, s, 'load_shedding') || d.has(c, s, 'rolling_blackout')).map(([c, s, label]) => [
        label,
        ...OUTAGE_POWERS.flatMap((p) => {
            const raw = d.vec(c, s, p, (run) => (run.time_to_recovery_wait_seconds == null ? -1 : run.time_to_recovery_wait_seconds));
            const runs = finite(raw);
            if (!runs.length) return ['n/a', 'n/a', 'n/a'];
            const capped = finite(recoveryVec(d, c, s, p, capFor(p)));
            return [`${runs.filter((v) => v >= 0).length}/${runs.length}`, fixed(mean(capped), 0), fixed(median(capped), 0)];
        }),
    ]);
}

function tableSensors(d) {
    const rows = [];
    for (const c of ['adaptive', 'coordinated_adaptive']) {
        for (const p of POWERS) {
            if (!d.has(c, 'avg', p)) continue;
            const columns = SENSORS.map((s) => d.vec(c, s, p, 'avg_wait_time'));
            const keep = d.seeds.map((_, i) => columns.every((column) => Number.isFinite(column[i])));
            const complete = columns.map((column) => column.filter((_, i) => keep[i]));
            const means = complete.map(mean);
            const fr = friedman(complete);
            rows.push([
                SHORT_NAME[c],
                powerLabel(p),
                ...means.map((m) => fixed(m, 2)),
                fixed(Math.max(...means) - Math.min(...means), 2),
                `${fixed(fr.chi2, 1)} (${fmtP(fr.p)})`,
                fixed(fr.w, 2),
            ]);
        }
    }
    return rows;
}

function tableCoordination(d) {
    return POWERS.filter((p) => d.has('coordinated_adaptive', 'avg', p) && d.has('adaptive', 'avg', p)).map((p) => [
        powerLabel(p),
        ...[...SCOPE_KEYS, 'pct_cleared_without_stop'].map((key) => {
            const st = pairedOn(d.vec('coordinated_adaptive', 'avg', p, key), d.vec('adaptive', 'avg', p, key));
            return st ? `${signed(st.diff, 2)} ± ${fixed(st.ci, 2)} (${fmtP(st.p)})` : 'n/a';
        }),
    ]);
}

function tableSensorVariants(d) {
    return VARIANT_ROWS.slice(2).map(([c, s, label]) => [
        label,
        ...POWERS.map((p) => {
            const st = pairedOn(d.vec(c, s, p, 'avg_wait_time'), d.vec('fixed', null, p, 'avg_wait_time'));
            return st ? `${signed(st.diff, 2)} ± ${fixed(st.ci, 2)} (${signed((100 * st.diff) / st.meanB, 1)}%), ${fixed(st.dz, 1)}` : 'n/a';
        }),
    ]);
}

/** Total delay (diagnostics.delay) - only batches from after it was recorded carry it. */
function tableDelay(d) {
    return CONTROLLER_ROWS.map(([c, s, label]) => [
        label,
        ...POWERS.map((p) => {
            const v = d.vec(c, s, p, 'delay_veh_h');
            if (!finite(v).length) return 'n/a';
            const st = c === 'fixed' ? null : pairedOn(v, d.vec('fixed', null, p, 'delay_veh_h'));
            return `${fixed(meanOf(v), 1)} ± ${fixed(ciOf(v), 1)}${st ? ` (${signed((100 * st.diff) / st.meanB, 1)}%)` : ''}`;
        }),
    ]);
}

/* --------------------------------------------------------------------- charts */

/** Error bars in data units: a dataset's `errorBars[i]` = { x?: [lo, hi], y?: [lo, hi] } around its i-th element. */
const errorBars = {
    id: 'errorBars',
    afterDatasetsDraw(chart) {
        const { ctx, scales } = chart;
        ctx.save();
        chart.data.datasets.forEach((dataset, di) => {
            if (!dataset.errorBars) return;
            const meta = chart.getDatasetMeta(di);
            ctx.strokeStyle = dataset.errorColour ?? dataset.borderColor ?? INK2;
            ctx.lineWidth = 1.4;
            dataset.errorBars.forEach((bar, i) => {
                const element = meta.data[i];
                if (!bar || !element) return;
                const cap = 4;
                ctx.beginPath();
                if (bar.x) {
                    const [x0, x1] = bar.x.map((v) => scales.x.getPixelForValue(v));
                    ctx.moveTo(x0, element.y);
                    ctx.lineTo(x1, element.y);
                    for (const x of [x0, x1]) {
                        ctx.moveTo(x, element.y - cap);
                        ctx.lineTo(x, element.y + cap);
                    }
                }
                if (bar.y) {
                    const [y0, y1] = bar.y.map((v) => scales.y.getPixelForValue(v));
                    ctx.moveTo(element.x, y0);
                    ctx.lineTo(element.x, y1);
                    for (const y of [y0, y1]) {
                        ctx.moveTo(element.x - cap, y);
                        ctx.lineTo(element.x + cap, y);
                    }
                }
                ctx.stroke();
            });
        });
        ctx.restore();
    },
};

/** A rule at value 0 on `axis` ('x' or 'y'), darker than the grid. */
const zeroLine = {
    id: 'zeroLine',
    beforeDatasetsDraw(chart, _args, opts) {
        if (!opts?.axis) return;
        const { ctx, chartArea, scales } = chart;
        const scale = scales[opts.axis];
        const at = scale.getPixelForValue(0);
        if (at < (opts.axis === 'x' ? chartArea.left : chartArea.top) || at > (opts.axis === 'x' ? chartArea.right : chartArea.bottom)) return;
        ctx.save();
        ctx.strokeStyle = INK2;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        if (opts.axis === 'x') {
            ctx.moveTo(at, chartArea.top);
            ctx.lineTo(at, chartArea.bottom);
        } else {
            ctx.moveTo(chartArea.left, at);
            ctx.lineTo(chartArea.right, at);
        }
        ctx.stroke();
        ctx.restore();
    },
};

/** Shaded x-ranges in data units with a label each: { from, to, colour, label }. */
const shadeBands = {
    id: 'shadeBands',
    beforeDatasetsDraw(chart, _args, opts) {
        const { ctx, chartArea, scales } = chart;
        for (const band of opts?.bands ?? []) {
            const x0 = scales.x.getPixelForValue(band.from);
            const x1 = scales.x.getPixelForValue(band.to);
            ctx.save();
            ctx.fillStyle = band.colour;
            ctx.fillRect(x0, chartArea.top, x1 - x0, chartArea.bottom - chartArea.top);
            ctx.fillStyle = INK2;
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(band.label, (x0 + x1) / 2, chartArea.top + 14);
            ctx.restore();
        }
    },
};

/** Box plots (box = IQR, line = median, whiskers to the furthest point within 1.5 IQR - matplotlib's) at x = 1..n. */
const boxPlots = {
    id: 'boxPlots',
    beforeDatasetsDraw(chart, _args, opts) {
        const { ctx, scales } = chart;
        for (const box of opts?.boxes ?? []) {
            const x = scales.x.getPixelForValue(box.x);
            const half = (scales.x.getPixelForValue(box.x + 0.275) - scales.x.getPixelForValue(box.x - 0.275)) / 2;
            const [q1, q3, med, lo, hi] = [box.q1, box.q3, box.median, box.lo, box.hi].map((v) => scales.y.getPixelForValue(v));
            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = box.colour;
            ctx.fillRect(x - half, q3, 2 * half, q1 - q3);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = INK2;
            ctx.lineWidth = 1;
            ctx.strokeRect(x - half, q3, 2 * half, q1 - q3);
            ctx.beginPath();
            ctx.moveTo(x, q1);
            ctx.lineTo(x, lo);
            ctx.moveTo(x - half / 2, lo);
            ctx.lineTo(x + half / 2, lo);
            ctx.moveTo(x, q3);
            ctx.lineTo(x, hi);
            ctx.moveTo(x - half / 2, hi);
            ctx.lineTo(x + half / 2, hi);
            ctx.stroke();
            ctx.strokeStyle = INK;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(x - half, med);
            ctx.lineTo(x + half, med);
            ctx.stroke();
            ctx.restore();
        }
        if (opts?.cap) {
            const { chartArea } = chart;
            const y = scales.y.getPixelForValue(opts.cap.value);
            ctx.save();
            ctx.strokeStyle = '#e34948';
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(chartArea.left, y);
            ctx.lineTo(chartArea.right, y);
            ctx.stroke();
            ctx.fillStyle = '#e34948';
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(opts.cap.label, chartArea.right - 4, y - 4);
            ctx.restore();
        }
    },
};

const legend = (show) => ({
    display: show,
    position: 'bottom',
    labels: { color: INK, font: { size: 12 }, usePointStyle: true, boxWidth: 10, padding: 14, filter: (item) => !item.text.startsWith('_') },
});

const axis = ({ title = '', min, max, ticks = {}, grid = true, reverse = false } = {}) => ({
    min,
    max,
    reverse,
    title: { display: Boolean(title), text: title, color: INK2, font: { size: 12 } },
    grid: { display: grid, color: GRID, drawTicks: false },
    border: { color: '#8a8984' },
    ticks: { color: INK2, font: { size: 12 }, padding: 6, ...ticks },
});

/** A linear axis labelled like a category axis: a tick at each of start, start + 1, ... named by `labels`. */
const categoryAxis = (labels, { start = 0, ticks = {}, ...rest } = {}) => ({
    ...axis({ grid: false, ...rest, ticks: { autoSkip: false, callback: (v) => labels[v - start] ?? '', ...ticks } }),
    afterBuildTicks: (scale) => {
        scale.ticks = labels.map((_, i) => ({ value: start + i }));
    },
});

/** A legend on its own, to sit under a row of panels instead of squeezing one of them. */
function legendImage(render, items, widthPx) {
    return render(
        {
            type: 'scatter',
            data: { datasets: items.map(({ label, colour, pointStyle = 'circle' }) => ({ label, data: [], pointStyle, backgroundColor: colour, borderColor: colour })) },
            options: { layout: { padding: { top: 4, bottom: 8 } }, plugins: { legend: legend(true), tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } } },
        },
        widthPx,
        64
    );
}

/** Each axis widened to take in the error bars - Chart.js ranges on the points alone and clips the whiskers. */
function errorBarRange(datasets, scales) {
    for (const key of ['x', 'y']) {
        const ends = datasets.flatMap((dataset) => (dataset.errorBars ?? []).flatMap((bar) => bar?.[key] ?? [])).filter(Number.isFinite);
        if (!ends.length || !scales[key]) continue;
        const pad = (Math.max(...ends) - Math.min(...ends)) * 0.04;
        scales[key] = { suggestedMin: Math.min(...ends) - pad, suggestedMax: Math.max(...ends) + pad, ...scales[key] };
    }
    return scales;
}

function chartImage(render, { type, datasets, scales, plugins = [], pluginOptions = {}, showLegend = true, title = null }, widthPx, heightPx) {
    return render(
        {
            type,
            data: { datasets },
            options: {
                layout: { padding: { top: 6, right: 14, bottom: 4, left: 4 } },
                plugins: {
                    legend: legend(showLegend),
                    tooltip: { enabled: false },
                    title: title ? { display: true, text: title, color: INK, font: { size: 13, weight: 'normal' } } : { display: false },
                    ...pluginOptions,
                },
                scales: errorBarRange(datasets, scales),
            },
            plugins: [errorBars, zeroLine, ...plugins],
        },
        widthPx,
        heightPx
    );
}

/** Data-URL images composed side by side ('row') or stacked ('column'), each at its own size. */
async function compose(images, direction = 'row') {
    const loaded = await Promise.all(
        images.map(
            (src) =>
                new Promise((resolve, reject) => {
                    const image = new Image();
                    image.onload = () => resolve(image);
                    image.onerror = reject;
                    image.src = src;
                })
        )
    );
    const row = direction === 'row';
    const canvas = document.createElement('canvas');
    canvas.width = row ? loaded.reduce((sum, i) => sum + i.width, 0) : Math.max(...loaded.map((i) => i.width));
    canvas.height = row ? Math.max(...loaded.map((i) => i.height)) : loaded.reduce((sum, i) => sum + i.height, 0);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let at = 0;
    for (const image of loaded) {
        ctx.drawImage(image, row ? at : 0, row ? 0 : at);
        at += row ? image.width : image.height;
    }
    return { image: canvas.toDataURL('image/png'), aspect: canvas.height / canvas.width };
}

const point = (x, y) => ({ x, y });

/** Figure A1: paired % change vs fixed-time, by scope (panels), controller (rows) and power state (markers). */
async function figurePctVsFixed(d, render) {
    const controllers = ['adaptive', 'green_wave', 'coordinated_adaptive'];
    const panels = [
        ['Total', 'avg_wait_time'],
        ['Main arterials', 'avg_wait_time_arterial'],
        ['Side streets', 'avg_wait_time_side_street'],
    ].map(([title, key], panel) => {
        const datasets = POWERS.map((p, j) => {
            const data = [];
            const bars = [];
            controllers.forEach((c, i) => {
                const base = d.vec('fixed', null, p, key);
                const st = pairedOn(d.vec(c, sensorOf(c), p, key), base);
                if (!st) return;
                const pct = (100 * st.diff) / st.meanB;
                const half = (100 * st.ci) / st.meanB;
                data.push(point(pct, i + (j - 1) * 0.22));
                bars.push({ x: [pct - half, pct + half] });
            });
            return { label: powerLabel(p), data, errorBars: bars, pointStyle: POWER_MARKER[p], pointRadius: 5, backgroundColor: POWER_COLOUR[p], borderColor: POWER_COLOUR[p] };
        });
        return chartImage(
            render,
            {
                type: 'scatter',
                datasets,
                title,
                showLegend: false,
                pluginOptions: { zeroLine: { axis: 'x' } },
                scales: {
                    x: axis({ title: panel === 1 ? 'Change in mean wait vs fixed-time, paired by seed (%, 95% CI)' : ' ' }),
                    y: categoryAxis(panel === 0 ? controllers.map((c) => NAME[c]) : controllers.map(() => ''), { min: -0.5, max: 2.5, reverse: true }),
                },
            },
            panel === 0 ? 420 : 290,
            300
        );
    });
    const row = await compose(panels);
    const key = legendImage(render, POWERS.map((p) => ({ label: powerLabel(p), colour: POWER_COLOUR[p], pointStyle: POWER_MARKER[p] })), 1000);
    return compose([row.image, key], 'column');
}

/** Figure A2: paired % change on each main road vs fixed-time, normal power. */
function figureRoads(d, render) {
    const controllers = ['adaptive', 'green_wave', 'coordinated_adaptive'];
    const roads = MAIN_ROADS.filter(([id]) => finite(d.vec('fixed', null, 'normal', (run) => run.road_waits?.[id])).length);
    const datasets = controllers.map((c) => {
        const values = [];
        const bars = [];
        for (const [id] of roads) {
            const st = pairedOn(d.vec(c, sensorOf(c), 'normal', (run) => run.road_waits?.[id]), d.vec('fixed', null, 'normal', (run) => run.road_waits?.[id]));
            const pct = st ? (100 * st.diff) / st.meanB : null;
            const half = st ? (100 * st.ci) / st.meanB : 0;
            values.push(pct);
            bars.push(st ? { x: [pct - half, pct + half] } : null);
        }
        return { label: NAME[c], data: values, errorBars: bars, errorColour: INK2, backgroundColor: COLOUR[c], borderColor: COLOUR[c], barPercentage: 0.9, categoryPercentage: 0.8 };
    });
    const image = render(
        {
            type: 'bar',
            data: { labels: roads.map(([, label]) => label), datasets },
            options: {
                indexAxis: 'y',
                layout: { padding: { top: 6, right: 14, bottom: 4, left: 4 } },
                plugins: { legend: legend(true), tooltip: { enabled: false }, zeroLine: { axis: 'x' } },
                scales: { x: axis({ title: 'Change in mean wait on the road vs fixed-time, normal power (%)' }), y: axis({ grid: false }) },
            },
            plugins: [errorBars, zeroLine],
        },
        1000,
        420
    );
    return { image, aspect: 0.42 };
}

/** Figure A3: the ITS - fixed-time gap at each power state, in seconds and in % of fixed-time wait. */
async function figureGap(d, render) {
    const controllers = ['adaptive', 'green_wave', 'coordinated_adaptive'];
    const offset = { adaptive: -0.08, green_wave: 0, coordinated_adaptive: 0.08 };
    const panel = (relative, title) => {
        const datasets = controllers.map((c) => {
            const data = [];
            const bars = [];
            POWERS.forEach((p, i) => {
                const base = d.vec('fixed', null, p, 'avg_wait_time');
                const gap = d.vec(c, sensorOf(c), p, 'avg_wait_time').map((v, k) => (relative ? (100 * (v - base[k])) / base[k] : v - base[k]));
                if (!finite(gap).length) return;
                const m = meanOf(gap);
                const half = ciOf(gap);
                data.push(point(i + offset[c], m));
                bars.push({ y: [m - half, m + half] });
            });
            return {
                label: NAME[c],
                data,
                errorBars: bars,
                showLine: true,
                borderDash: CONTROLLER_DASH[c],
                borderWidth: 2,
                pointStyle: CONTROLLER_MARKER[c],
                pointRadius: 5,
                backgroundColor: COLOUR[c],
                borderColor: COLOUR[c],
            };
        });
        return chartImage(
            render,
            {
                type: 'scatter',
                datasets,
                title,
                showLegend: false,
                pluginOptions: { zeroLine: { axis: 'y' } },
                scales: {
                    x: categoryAxis(['Normal', 'Total blackout', 'Load shedding'], { min: -0.4, max: 2.4 }),
                    y: axis({ title: relative ? 'Wait difference vs fixed-time (%)' : 'Wait difference vs fixed-time (s)' }),
                },
            },
            500,
            360
        );
    };
    const row = await compose([panel(false, 'Absolute gap (seconds saved)'), panel(true, 'Relative gap (% of fixed-time wait)')]);
    const key = legendImage(render, controllers.map((c) => ({ label: NAME[c], colour: COLOUR[c], pointStyle: CONTROLLER_MARKER[c] })), 1000);
    return compose([row.image, key], 'column');
}

/** Figure A4: network mean wait over the measured window, per controller, under each outage. */
async function figureTimeseries(data, timelineFor, render) {
    const panels = [];
    for (const p of OUTAGE_POWERS) {
        const timeline = timelineFor(data, p);
        if (!timeline?.seconds?.length) continue;
        const minutes = timeline.seconds.map((s) => s / 60);
        const datasets = CONTROLLERS.map((c) => {
            const curves = Object.keys(timeline.series ?? {})
                .filter((key) => key.startsWith(`${c}|`))
                .map((key) => timeline.series[key]?.avg_wait_time)
                .filter(Boolean);
            if (!curves.length) return null;
            const values = minutes.map((x, i) => {
                const at = finite(curves.map((curve) => curve[i]));
                return at.length ? point(x, mean(at)) : null;
            });
            return {
                label: NAME[c],
                data: values.filter(Boolean),
                showLine: true,
                pointRadius: 0,
                borderWidth: 2,
                borderDash: CONTROLLER_DASH[c],
                borderColor: COLOUR[c],
                backgroundColor: COLOUR[c],
            };
        }).filter(Boolean);
        const bands = (timeline.darkWindows ?? []).map((w) => ({
            from: w.fromS / 60,
            to: w.toS / 60,
            colour: w.zones?.length && !w.zones.includes(1) ? 'rgba(98,80,214,0.10)' : 'rgba(227,73,72,0.10)',
            label: w.zones?.length ? `Zone${w.zones.length > 1 ? 's' : ''} ${w.zones.join(' + ')} dark` : 'All junctions dark',
        }));
        panels.push(
            chartImage(
                render,
                {
                    type: 'scatter',
                    datasets,
                    title: powerLabel(p),
                    showLegend: p === 'rolling_blackout',
                    plugins: [shadeBands],
                    pluginOptions: { shadeBands: { bands } },
                    scales: {
                        x: axis({ min: 0, max: Math.ceil(minutes.at(-1) / 15) * 15, title: p === 'rolling_blackout' ? 'Minutes into the measured window' : '', ticks: { stepSize: 15 } }),
                        y: axis({ min: 0, title: 'Mean wait (s)' }),
                    },
                },
                1000,
                p === 'rolling_blackout' ? 380 : 330
            )
        );
    }
    return panels.length ? compose(panels, 'column') : null;
}

function quantile(sorted, q) {
    const at = (sorted.length - 1) * q;
    const lo = Math.floor(at);
    return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (at - lo);
}

/** Figure A5: wait-recovery times by controller and sensor - box plots with every seed as a point. */
async function figureRecovery(d, capFor, render) {
    const groups = [
        ['fixed', null, 'Fixed'],
        ['green_wave', null, 'Green wave'],
        ...SENSORS.map((s) => ['adaptive', s, `Adapt. ${SENSOR_SHORT[s]}`]),
        ...SENSORS.map((s) => ['coordinated_adaptive', s, `Coord. ${SENSOR_SHORT[s]}`]),
    ];
    let seed = 1;
    const jitter = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed / 2147483647 - 0.5) * 0.3;
    };
    const panels = OUTAGE_POWERS.map((p, panel) => {
        const capMin = capFor(p) / 60;
        const boxes = [];
        const points = [];
        groups.forEach(([c, s], k) => {
            const values = finite(recoveryVec(d, c, s, p, capFor(p))).map((v) => v / 60);
            if (!values.length) return;
            const sorted = [...values].sort((a, b) => a - b);
            const q1 = quantile(sorted, 0.25);
            const q3 = quantile(sorted, 0.75);
            const reach = 1.5 * (q3 - q1);
            boxes.push({
                x: k + 1,
                q1,
                q3,
                median: quantile(sorted, 0.5),
                lo: sorted.find((v) => v >= q1 - reach),
                hi: [...sorted].reverse().find((v) => v <= q3 + reach),
                colour: COLOUR[c],
            });
            values.forEach((v) => points.push(point(k + 1 + jitter(), v)));
        });
        const restore = p === 'load_shedding' ? 'from restore' : 'from final restore';
        return chartImage(
            render,
            {
                type: 'scatter',
                datasets: [{ label: '_seeds', data: points, pointRadius: 2, backgroundColor: 'rgba(82,81,78,0.6)', borderWidth: 0 }],
                title: `${powerLabel(p)} (${restore})`,
                showLegend: false,
                plugins: [boxPlots],
                pluginOptions: { boxPlots: { boxes, cap: { value: capMin, label: `cap ${Math.round(capMin)} min` } } },
                scales: {
                    x: categoryAxis(groups.map((g) => g[2]), { start: 1, min: 0.4, max: groups.length + 0.6, ticks: { maxRotation: 90, minRotation: 90 } }),
                    y: axis({ min: 0, max: Math.ceil(capMin / 10) * 10 + 5, title: panel === 0 ? 'Wait recovery time (min, capped)' : '' }),
                },
            },
            500,
            440
        );
    });
    return compose(panels);
}

/** Figure A6: mean wait by controller and power state, with 95% intervals and value labels. */
function figureWaitByController(d, render) {
    const datasets = CONTROLLERS.map((c) => {
        const values = POWERS.map((p) => meanOf(d.vec(c, sensorOf(c), p, 'avg_wait_time')));
        return {
            label: NAME[c],
            data: values.map((v) => (Number.isFinite(v) ? Number(v.toFixed(1)) : null)),
            errorBars: POWERS.map((p, i) => {
                const half = ciOf(d.vec(c, sensorOf(c), p, 'avg_wait_time'));
                return Number.isFinite(values[i]) ? { y: [values[i] - half, values[i] + half] } : null;
            }),
            errorColour: INK2,
            backgroundColor: COLOUR[c],
            borderColor: COLOUR[c],
            barPercentage: 0.9,
            categoryPercentage: 0.8,
        };
    });
    const labels = {
        id: 'labels',
        afterDatasetsDraw(chart) {
            const { ctx } = chart;
            ctx.save();
            ctx.fillStyle = INK;
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'center';
            chart.data.datasets.forEach((dataset, di) =>
                chart.getDatasetMeta(di).data.forEach((bar, i) => {
                    const top = dataset.errorBars[i] ? chart.scales.y.getPixelForValue(dataset.errorBars[i].y[1]) : bar.y;
                    if (dataset.data[i] != null) ctx.fillText(dataset.data[i].toFixed(1), bar.x, top - 5);
                })
            );
            ctx.restore();
        },
    };
    const image = render(
        {
            type: 'bar',
            data: { labels: POWERS.map(powerLabel), datasets },
            options: {
                layout: { padding: { top: 16, right: 14, bottom: 4, left: 4 } },
                plugins: { legend: legend(true), tooltip: { enabled: false } },
                scales: { x: axis({ grid: false }), y: axis({ min: 0, title: 'Mean wait per vehicle (s)' }) },
            },
            plugins: [errorBars, labels],
        },
        1000,
        440
    );
    return { image, aspect: 0.44 };
}

/** Figure A7: segment means of total wait, by controller. */
async function figureSegments(d, render) {
    const panels = OUTAGE_POWERS.map((p) => {
        const columns = SEGMENT_COLUMNS.filter(([power, key]) => power === p || (p === 'rolling_blackout' && key === 'avg_wait_time_pre_outage'));
        const labels = columns.map(([, key, label]) => (key === 'avg_wait_time_pre_outage' ? 'Pre-outage' : label.replace(/ \((TB|LS)\)/, '')));
        const datasets = CONTROLLERS.map((c) => ({
            label: NAME[c],
            data: columns.map(([, key]) => {
                const v = meanOf(d.vec(c, sensorOf(c), p, key));
                return Number.isFinite(v) ? v : null;
            }),
            backgroundColor: COLOUR[c],
            barPercentage: 0.9,
            categoryPercentage: 0.8,
        }));
        return render(
            {
                type: 'bar',
                data: { labels, datasets },
                options: {
                    layout: { padding: { top: 6, right: 14, bottom: 4, left: 4 } },
                    plugins: { legend: legend(false), tooltip: { enabled: false }, title: { display: true, text: powerLabel(p), color: INK, font: { size: 13, weight: 'normal' } } },
                    scales: { x: axis({ grid: false }), y: axis({ min: 0, title: p === 'load_shedding' ? 'Mean wait (s)' : '' }) },
                },
            },
            p === 'load_shedding' ? 430 : 570,
            340
        );
    });
    const row = await compose(panels);
    const key = legendImage(render, CONTROLLERS.map((c) => ({ label: NAME[c], colour: COLOUR[c], pointStyle: 'rect' })), 1000);
    return compose([row.image, key], 'column');
}

/** Figure A8: mean wait by sensor within each adaptive controller and power state. */
async function figureSensors(d, render) {
    const panels = ['adaptive', 'coordinated_adaptive'].map((c, panel) => {
        const datasets = SENSORS.map((s, j) => {
            const data = [];
            const bars = [];
            POWERS.forEach((p, i) => {
                const v = d.vec(c, s, p, 'avg_wait_time');
                if (!finite(v).length) return;
                const m = meanOf(v);
                const half = ciOf(v);
                data.push(point(i + (j - 1.5) * 0.15, m));
                bars.push({ y: [m - half, m + half] });
            });
            return { label: SENSOR_NAME[s], data, errorBars: bars, pointStyle: SENSOR_MARKER[s], pointRadius: 5, backgroundColor: SENSOR_COLOUR[s], borderColor: SENSOR_COLOUR[s] };
        });
        return chartImage(
            render,
            {
                type: 'scatter',
                datasets,
                title: NAME[c],
                showLegend: false,
                scales: {
                    x: categoryAxis(['Normal', 'Total blackout', 'Load shedding'], { min: -0.5, max: 2.5 }),
                    y: axis({ title: panel === 0 ? 'Mean wait per vehicle (s)' : '' }),
                },
            },
            500,
            340
        );
    });
    const row = await compose(panels);
    const key = legendImage(render, SENSORS.map((s) => ({ label: SENSOR_NAME[s], colour: SENSOR_COLOUR[s], pointStyle: SENSOR_MARKER[s] })), 1000);
    return compose([row.image, key], 'column');
}

/** Figure A9: coordinated minus plain adaptive - arterial change against side-street change, by sensor and power state. */
function figureCoordTradeoff(d, render) {
    const datasets = [];
    for (const s of SENSORS) {
        for (const p of POWERS) {
            const art = pairedOn(d.vec('coordinated_adaptive', s, p, 'avg_wait_time_arterial'), d.vec('adaptive', s, p, 'avg_wait_time_arterial'));
            const side = pairedOn(d.vec('coordinated_adaptive', s, p, 'avg_wait_time_side_street'), d.vec('adaptive', s, p, 'avg_wait_time_side_street'));
            if (!art || !side) continue;
            datasets.push({
                label: `_${s}|${p}`,
                data: [point(art.diff, side.diff)],
                errorBars: [{ x: [art.diff - art.ci, art.diff + art.ci], y: [side.diff - side.ci, side.diff + side.ci] }],
                pointStyle: POWER_MARKER[p],
                pointRadius: 6,
                backgroundColor: SENSOR_COLOUR[s],
                borderColor: SENSOR_COLOUR[s],
                errorColour: SENSOR_COLOUR[s],
            });
        }
    }
    // Legend-only entries: colour = sensor, marker = power state.
    const keys = [
        ...SENSORS.map((s) => ({ label: SENSOR_NAME[s], data: [], pointStyle: 'circle', backgroundColor: SENSOR_COLOUR[s], borderColor: SENSOR_COLOUR[s] })),
        ...POWERS.map((p) => ({ label: powerLabel(p), data: [], pointStyle: POWER_MARKER[p], backgroundColor: INK2, borderColor: INK2 })),
    ];
    const image = chartImage(
        render,
        {
            type: 'scatter',
            datasets: [...datasets, ...keys],
            title: 'Coordinated minus plain adaptive',
            pluginOptions: { zeroLine: { axis: 'x' }, legend: { ...legend(true), position: 'right' } },
            plugins: [
                {
                    id: 'zeroY',
                    beforeDatasetsDraw: (chart) => zeroLine.beforeDatasetsDraw(chart, null, { axis: 'y' }),
                },
            ],
            scales: { x: axis({ title: 'Arterial wait change (s)' }), y: axis({ title: 'Side-street wait change (s)' }) },
        },
        1000,
        480
    );
    return { image, aspect: 0.48 };
}

/* -------------------------------------------------------------------- drawing */

/**
 * Draws the appendix into `report` (resultsPdf.js's Report). `helpers`: renderChartImage, timelineFor and the page's
 * content width (mm) - passed in so this module needs nothing else from resultsPdf.js.
 */
export async function drawDetailedAppendix(report, runs, data, { renderChartImage, timelineFor, contentWidthMm }) {
    const d = indexRuns(runs);
    const capFor = (power) => data.batchStamp?.postRestoreWindowSByScope?.[power]?.total ?? FALLBACK_CAP_S[power];
    const table = (title, caption, head, body, note = null) => {
        if (!body.length) return;
        report.heading(title, caption, { level: 'card' });
        report.table({ head: [head], body });
        if (note) report.paragraph(note);
    };
    const figure = (title, caption, built) => {
        if (!built) return;
        report.ensureSpace(contentWidthMm * built.aspect + 22);
        report.heading(title, caption, { level: 'card' });
        report.image(built.image, contentWidthMm, contentWidthMm * built.aspect);
    };

    report.newPage();
    report.sectionTitle(
        'Appendix: detailed figures and tables',
        `Every figure and table below recomputed from this batch (${runs.length} runs, ${d.seeds.length} seeds)`
    );
    report.paragraph(
        'Method: one value per run, paired by seed; "Adaptive" and "Coordinated adaptive" without a sensor are the per-seed mean of the four sensors; ± is the 95% t confidence half-width; p values use the paired t test, or Wilcoxon where Shapiro-Wilk rejects normality of the differences. The figures use a fixed print palette so they can be reused as standalone images.'
    );

    figure('Figure A1', 'Paired change in mean wait relative to fixed-time by scope and power state (95% confidence intervals of the per-seed differences).', await figurePctVsFixed(d, renderChartImage));
    figure('Figure A2', 'Paired change in mean wait on each main road relative to fixed-time at normal power (road-level means over vehicles using the road; 95% confidence intervals).', figureRoads(d, renderChartImage));
    figure('Figure A3', 'The ITS–fixed-time gap at normal power and under each outage, in seconds (left) and as a percentage of fixed-time wait (right). Error bars are 95% confidence intervals of the per-seed gap.', await figureGap(d, renderChartImage));
    figure('Figure A4', 'Network mean wait over the measured window under the total blackout (top) and load shedding (bottom), averaged over the seeds (and over sensors for the adaptive controllers). Shaded bands mark the dark periods.', await figureTimeseries(data, timelineFor, renderChartImage));
    figure('Figure A5', 'Distribution of wait-recovery times by controller and sensor (box: interquartile range; points: individual seeds; dashed line: cap).', await figureRecovery(d, capFor, renderChartImage));
    figure('Figure A6', 'Mean wait per vehicle by controller and power state (total scope; sensor means for the adaptive controllers; error bars are 95% confidence intervals). The chart form of Table A1.', figureWaitByController(d, renderChartImage));
    figure('Figure A7', 'Segment means of total wait before, during and after each outage, by controller. The chart form of Table A6.', await figureSegments(d, renderChartImage));
    figure('Figure A8', 'Mean wait per vehicle by sensor model within each adaptive controller and power state (95% confidence intervals). The chart form of Table A8.', await figureSensors(d, renderChartImage));
    figure('Figure A9', 'Coordinated minus plain adaptive control on the same seeds: change in arterial wait against change in side-street wait, by sensor (colour) and power state (marker); 95% confidence intervals. The chart form of Table A9.', figureCoordTradeoff(d, renderChartImage));

    report.newPage();
    table(
        'Table A1',
        `Mean wait per vehicle by controller, sensor and power state (total scope; ${d.seeds.length} runs per cell). Waits include the dark minutes of each outage run.`,
        ['Controller (sensor)', 'Normal wait (s)', 'Total blackout wait (s)', 'Load shedding wait (s)', 'Cleared w/o stop, normal (%)', 'Throughput, normal (veh/min)'],
        tableCondMeans(d)
    );
    table(
        'Table A2',
        'Paired difference in mean wait relative to fixed-time on the same seeds (seconds ± 95% CI, with the percentage of the fixed-time mean). Negative is better.',
        ['Power state', 'Controller', 'Total diff. s (%)', 'Arterial diff. s (%)', 'Side streets diff. s (%)', 'dz (total)'],
        tableVsFixed(d)
    );
    table(
        'Table A3',
        'Wait distribution by controller and power state (total scope; seconds, means over runs). N = normal, TB = total blackout, LS = load shedding.',
        ['Controller', ...['Median', 'P95', 'Run max'].flatMap((m) => POWERS.map((p) => `${m} ${POWER_SHORT[p]}`))],
        tableTails(d)
    );
    table(
        'Table A4',
        'Degradation: increase in mean wait from normal power to each outage on the same seeds.',
        ['Controller', 'Normal (s)', 'Total blackout increase (s)', 'Load shedding increase (s)'],
        tableDegradation(d)
    );
    table(
        'Table A5',
        'RQ1 difference-in-differences: change in the ITS–fixed-time gap from normal power to outage (paired by seed). Relative gaps are means of per-seed percentages.',
        ['Controller', 'Outage', 'Gap normal (s)', 'Gap outage (s)', 'Change in absolute gap (s)', 'p', 'Gap normal (%)', 'Gap outage (%)', 'Change in relative gap (pp)', 'p'],
        tableDiD(d)
    );
    table(
        'Table A6',
        'Segment means of total wait (s): before, during and after each outage. Each vehicle is counted in the segment in which it cleared.',
        ['Controller', ...SEGMENT_COLUMNS.map(([, , label]) => label)],
        tableSegments(d)
    );
    table(
        'Table A7',
        `Wait recovery after power is restored: share of runs that recovered, and capped mean and median recovery time. Runs that did not recover count at the cap (${Math.round(capFor('load_shedding'))} s total blackout, ${Math.round(capFor('rolling_blackout'))} s load shedding), so capped means are lower bounds.`,
        ['Controller (sensor)', 'TB recovered', 'TB capped mean (s)', 'TB median (s)', 'LS recovered', 'LS capped mean (s)', 'LS median (s)'],
        tableRecovery(d, capFor)
    );
    table(
        'Table A8',
        'Mean wait (s) by sensor model within each adaptive controller, with Friedman tests across the four sensors.',
        ['Controller', 'Power', 'Loop', 'Radar', 'Camera', 'Magnetometer', 'Range (s)', 'Friedman chi-sq. (p)', 'Kendall W'],
        tableSensors(d)
    );
    table(
        'Table A9',
        'Coordinated adaptive minus plain adaptive control on the same seeds (sensor means; ± 95% CI, p in brackets).',
        ['Power', 'Total diff. (s)', 'Arterial diff. (s)', 'Side streets diff. (s)', 'Cleared w/o stop diff. (pp)'],
        tableCoordination(d)
    );
    table(
        'Table A10',
        'Each sensor variant against fixed-time, total scope (paired by seed; seconds ± 95% CI, percentage of the fixed-time mean, dz).',
        ['Variant', 'Normal', 'Total blackout', 'Load shedding'],
        tableSensorVariants(d)
    );
    if (runs.some((run) => Number.isFinite(run.delay_veh_h))) {
        table(
            'Total delay',
            'Total delay over the measured window (vehicle-hours, mean ± 95% CI; % change vs fixed-time on the same seeds): every second any vehicle stood, those still in the network at the end included, plus arrivals turned away at full entries charged to the window\'s end.',
            ['Controller', ...POWERS.map(powerLabel)],
            tableDelay(d)
        );
    }
}
