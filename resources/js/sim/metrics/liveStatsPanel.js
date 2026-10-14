/**
 * liveStatsPanel.js - the simulator's live statistics footer: the collapsed KPI bar and the
 * expanded panels, road table and throughput chart.
 *
 * Display only. Every number arrives already computed in a liveMetrics.js sample; this file
 * formats and places it, once a simulated second, writing a node only when its text changes.
 */
import { Chart, INK, baseOptions, lineDataset, xRangeBand } from '../../charts/theme.js';

const STORAGE_KEY = 'sim.liveStats';
const STATES = ['collapsed', 'expanded'];

const PILL_BASE = 'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium';
const PILL = {
    neutral: `${PILL_BASE} border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-400`,
    good: `${PILL_BASE} border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300`,
    warn: `${PILL_BASE} border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300`,
    bad: `${PILL_BASE} border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-500/50 dark:bg-rose-500/15 dark:text-rose-300`,
};
const DOT = {
    neutral: 'h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500',
    good: 'h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400',
    warn: 'h-1.5 w-1.5 rounded-full bg-amber-500 dark:bg-amber-400',
    bad: 'h-1.5 w-1.5 rounded-full bg-rose-500 dark:bg-rose-400',
};

const DASH = '—';
const num = (value, decimals = 0) => (value == null || !Number.isFinite(value) ? DASH : value.toFixed(decimals));
const pct = (value) => (value == null ? DASH : `${value.toFixed(0)}%`);
const seconds = (value) => (value == null ? DASH : `${value.toFixed(1)} s`);
const signed = (value, decimals) => (value > 0 ? '+' : '') + value.toFixed(decimals);
export function clock(totalS) {
    const s = Math.max(0, Math.floor(totalS));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** The KPI tiles, each with the sample field it shows and how. */
const KPI_FORMAT = {
    onNetwork: (s) => num(s.onNetwork),
    throughput: (s) => num(s.throughputPerMin),
    avgWait: (s) => num(s.avgWaitRolling, 1),
    stopsPerVeh: (s) => num(s.stopsPerVeh, 2),
    zeroStopPct: (s) => num(s.zeroStopPct, 0),
    stranded: (s) => num(s.stranded),
};

const ROW_FORMAT = {
    onNetwork: (s) => num(s.onNetwork),
    completed: (s) => num(s.completed),
    throughputPerMin: (s) => `${num(s.throughputPerMin)}, run ${num(s.throughputRunPerMin, 1)}`,
    avgSpeedKph: (s) => num(s.avgSpeedKph, 1),
    avgWaitRolling: (s) => seconds(s.avgWaitRolling),
    avgWaitRun: (s) => seconds(s.avgWaitRun),
    tripDelayS: (s) => seconds(s.tripDelayS),
    stopsPerVeh: (s) => num(s.stopsPerVeh, 2),
    zeroStopPct: (s) => pct(s.zeroStopPct),
    arrivalsOnGreenPct: (s) => pct(s.arrivalsOnGreenPct),
    avgQueue: (s) => num(s.avgQueue, 1),
    maxQueue: (s) => (s.maxQueue ? `${s.maxQueue.queue} at ${s.maxQueue.nodeName} (${s.maxQueue.roadName})` : '0'),
    spillback: (s) => `${s.spillbackNow} / ${s.spillbackEvents}`,
    blocked: (s) => `${s.blockedNow} / ${s.blockedEvents}`,
    stranded: (s) => num(s.stranded),
    drift: (s) => (s.drift === 'settling' ? 'Settling' : `${s.drift === 'settled' ? 'Settled' : 'Drifting'} (${num((s.driftRatio ?? 0) * 100, 0)}% / 10 min)`),
    signalsDark: (s) => `${s.signalsDark}/${s.signalsTotal}`,
    outage: (s) => `${s.power.state === 'load_shedding' ? 'Out' : 'On'} for ${clock(s.power.forS)}`,
    recoveryPct: (s) => pct(s.power.recoveryPct),
    divertedPct: (s) => pct(s.routing?.divertedPct),
    missedDrivewaysPct: (s) => pct(s.routing?.missedDrivewaysPct),
    missedTurns: (s) => num(s.routing?.missedTurns),
    lostArrivals: (s) => num(s.routing?.lostArrivals),
    drivewayWaitS: (s) => seconds(s.routing?.drivewayWaitS),
    carsInDriveways: (s) => num(s.routing?.carsInDriveways),
};

const ROAD_FORMAT = {
    name: (r) => r.name,
    onRoad: (r) => num(r.onRoad),
    avgWaitNow: (r) => seconds(r.avgWaitNow),
    clearedPerMin: (r) => num(r.clearedPerMin),
    zeroStopPct: (r) => pct(r.zeroStopPct),
    queue: (r) => num(r.queue),
};

export class LiveStatsPanel {
    /**
     * @param root the #live-stats footer
     * @param onSelectCar called with a car id when the longest-wait vehicle is clicked
     * @param shortNodeLabel names a junction for the per-section chips
     */
    constructor(root, { onSelectCar, shortNodeLabel }) {
        this.root = root;
        this.onSelectCar = onSelectCar;
        this.shortNodeLabel = shortNodeLabel;
        this.toggleButton = root.querySelector('#live-stats-toggle');
        this.roadBody = root.querySelector('#live-road-rows');
        this.chartCanvas = root.querySelector('#stats-chart');
        this.chartEmpty = root.querySelector('#stats-chart-empty');
        this.kpis = [...root.querySelectorAll('[data-kpi]')].map((tile) => ({
            key: tile.dataset.kpi,
            value: tile.querySelector('[data-kpi-value]'),
            spark: tile.querySelector('[data-spark]'),
        }));
        this.rows = new Map([...root.querySelectorAll('[data-live]')].map((node) => [node.dataset.live, node]));
        this.routingPanel = root.querySelector('[data-live-panel="routing"]');
        this.tripDelayRow = root.querySelector('[data-live-row="tripDelayS"]');
        this.replayRow = root.querySelector('[data-live-row="replayDelta"]');
        this.sort = { key: 'name', descending: false };
        this.openRoads = new Set();
        this.replayTwin = null;
        this.chart = null;
        this.chartPointCount = -1;
        this.chartOutageKey = '';
        this.latest = null;
        this.lastCollector = null;

        this.toggleButton.addEventListener('click', () => this.toggle());
        root.querySelectorAll('[data-sort]').forEach((button) => button.addEventListener('click', () => this._sortBy(button.dataset.sort)));
        this.roadBody.addEventListener('click', (event) => {
            const toggle = event.target.closest('[data-road-toggle]');
            if (!toggle) return;
            const key = toggle.dataset.roadToggle;
            if (this.openRoads.has(key)) this.openRoads.delete(key);
            else this.openRoads.add(key);
            if (this.latest) this._renderRoads(this.latest.roads);
        });
        this.rows.get('worst').addEventListener('click', (event) => {
            const id = event.target.closest('[data-car-id]')?.dataset.carId;
            if (id != null) this.onSelectCar(Number(id));
        });

        this._setExpanded(storedState() === 'expanded', { persist: false });
        this._renderSortMarks();
        this.buildChart();
    }

    get expanded() {
        return this.root.dataset.expanded === 'true';
    }

    toggle() {
        this._setExpanded(!this.expanded);
    }

    /** Routing block and trip delay only in destination mode; the replay delta only with a fixed-time twin to compare with. */
    setContext({ routingActive, replayTwin = null }) {
        this.routingPanel.classList.toggle('hidden', !routingActive);
        this.tripDelayRow.classList.toggle('hidden', !routingActive);
        this.replayTwin = replayTwin;
        this.replayRow.classList.toggle('hidden', !replayTwin);
    }

    /** Back to dashes and an empty chart - Reset, a new corridor, a replay. */
    reset() {
        this.latest = null;
        for (const tile of this.kpis) {
            setText(tile.value, DASH);
            this._drawSpark(tile.spark, []);
        }
        for (const node of this.rows.values()) setText(node, DASH);
        this.roadBody.replaceChildren();
        this._chip('power', 'good', 'Power on');
        this._chip('drift', 'neutral', 'Settling');
        this._chip('spillback', 'neutral', '0 spillbacks');
        this.buildChart();
    }

    /** One 1 Hz sample from liveMetrics.js. */
    update(sample, collector) {
        this.latest = sample;
        this.lastCollector = collector;
        for (const tile of this.kpis) {
            setText(tile.value, KPI_FORMAT[tile.key](sample));
            this._drawSpark(tile.spark, collector.sparkline(tile.key));
        }
        this._renderChips(sample);
        if (!this.expanded) return;
        this._renderDetails(sample, collector);
    }

    /** The chart paints its own colours, so a theme change rebuilds it; sparklines redraw on the next sample. */
    setTheme() {
        this.buildChart();
        if (this.latest && this.lastCollector) this.update(this.latest, this.lastCollector);
    }

    buildChart() {
        this.chart?.destroy();
        const options = baseOptions({ tickFormat: (v) => `${v}` });
        options.layout.padding.top = 14;
        options.scales.x.ticks.maxTicksLimit = 6;
        this.chart = new Chart(this.chartCanvas, {
            type: 'line',
            data: { labels: [], datasets: [lineDataset({ label: 'Throughput', data: [], colour: INK.secondary })] },
            options,
            plugins: [xRangeBand],
        });
        this.chartPointCount = -1;
        this.chartOutageKey = '';
        this.chartEmpty?.classList.remove('hidden');
    }

    /* ----------------------------------------------------------- internals */

    _setExpanded(expanded, { persist = true } = {}) {
        this.root.dataset.expanded = String(expanded);
        this.toggleButton.setAttribute('aria-expanded', String(expanded));
        if (persist) storeState(expanded ? 'expanded' : 'collapsed');
        if (expanded && this.latest && this.lastCollector) this._renderDetails(this.latest, this.lastCollector);
    }

    _renderDetails(sample, collector) {
        for (const [key, node] of this.rows) {
            if (key === 'worst') this._renderWorst(node, sample.worst);
            else if (key === 'replayDelta') setText(node, this._replayDelta(sample));
            else setText(node, ROW_FORMAT[key](sample));
        }
        this._renderRoads(sample.roads);
        this._renderChart(collector.chartSeries());
    }

    _renderChips(sample) {
        const { power } = sample;
        if (power.state === 'load_shedding') this._chip('power', 'bad', `Lights out ${clock(power.forS)}`);
        else if (power.recoveryPct != null) this._chip('power', 'good', `Restored ${clock(power.forS)}, ${pct(power.recoveryPct)}`);
        else this._chip('power', 'good', 'Power on');

        if (sample.drift === 'settled') this._chip('drift', 'good', 'Settled');
        else if (sample.drift === 'drifting') this._chip('drift', 'warn', 'Drifting');
        else this._chip('drift', 'neutral', 'Settling');

        const n = sample.spillbackNow;
        this._chip('spillback', n ? 'warn' : 'neutral', `${n} spillback${n === 1 ? '' : 's'}`);
    }

    _chip(name, tone, text) {
        const chip = this.root.querySelector(`#live-chip-${name}`);
        if (chip.className !== PILL[tone]) {
            chip.className = PILL[tone];
            chip.querySelector('[data-chip-dot]').className = DOT[tone];
        }
        setText(chip.querySelector('[data-chip-text]'), text);
    }

    _renderWorst(node, worst) {
        const text = worst && worst.waitS > 0 ? `#${worst.id}, ${worst.waitS.toFixed(0)} s${worst.roadName ? `, ${worst.roadName}` : ''}` : DASH;
        if (node.dataset.text === text) return;
        node.dataset.text = text;
        if (text === DASH) {
            node.textContent = DASH;
            return;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.carId = String(worst.id);
        button.title = 'Follow this vehicle';
        button.className = 'max-w-full truncate text-sky-700 underline decoration-dotted underline-offset-2 hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-100';
        button.textContent = text;
        node.replaceChildren(button);
    }

    _replayDelta(sample) {
        const twin = this.replayTwin;
        if (!twin) return DASH;
        const wait = sample.avgWaitRun - Number(twin.avg_wait_time);
        const throughput = sample.throughputRunPerMin - Number(twin.throughput_per_min);
        return `wait ${signed(wait, 1)} s, ${signed(throughput, 1)} veh/min`;
    }

    _sortBy(key) {
        this.sort = { key, descending: this.sort.key === key ? !this.sort.descending : key !== 'name' };
        this._renderSortMarks();
        if (this.latest) this._renderRoads(this.latest.roads);
    }

    _renderSortMarks() {
        this.root.querySelectorAll('[data-sort]').forEach((button) => {
            const mark = button.querySelector('[data-sort-mark]');
            mark.textContent = button.dataset.sort === this.sort.key ? (this.sort.descending ? '▾' : '▴') : '';
        });
    }

    _renderRoads(roads) {
        const { key, descending } = this.sort;
        const sorted = [...roads].sort((a, b) => {
            const order = key === 'name' ? a.name.localeCompare(b.name) : (a[key] ?? -1) - (b[key] ?? -1);
            return descending ? -order : order;
        });
        const rows = [];
        for (const road of sorted) {
            const tr = document.createElement('tr');
            tr.className = 'border-b border-slate-100 last:border-0 dark:border-slate-800/60';
            for (const [column, format] of Object.entries(ROAD_FORMAT)) {
                const td = document.createElement('td');
                td.className = column === 'name' ? 'py-1 pe-3 text-left text-slate-700 dark:text-slate-300' : 'py-1 ps-3 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100';
                if (column === 'name' && road.clearedByNode) {
                    const open = this.openRoads.has(road.key);
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.dataset.roadToggle = road.key;
                    button.title = 'Cleared by road section';
                    button.className = 'inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-100';
                    button.textContent = `${open ? '▾' : '▸'} ${road.name}`;
                    td.append(button);
                } else {
                    td.textContent = format(road);
                }
                tr.append(td);
            }
            rows.push(tr);
            if (road.clearedByNode && this.openRoads.has(road.key)) rows.push(this._sectionRow(road));
        }
        this.roadBody.replaceChildren(...rows);
    }

    /** The arterial's "cleared by road section" counts, one chip per junction plus its total. */
    _sectionRow(road) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = Object.keys(ROAD_FORMAT).length;
        td.className = 'pb-2';
        const chips = document.createElement('div');
        chips.className = 'flex flex-wrap gap-1';
        const chip = (label, value) => {
            const node = document.getElementById('cleared-chip-template').content.firstElementChild.cloneNode(true);
            node.querySelector('[data-chip-label]').textContent = label;
            node.querySelector('[data-chip-value]').textContent = String(value);
            return node;
        };
        chips.append(...road.clearedByNode.map(({ node, cleared }) => chip(this.shortNodeLabel(node), cleared)), chip('Total', road.clearedTotal));
        td.append(chips);
        tr.append(td);
        return tr;
    }

    _renderChart({ points, outages }) {
        const outageKey = outages.map((o) => `${o.fromS}-${o.toS}`).join(',');
        if (points.length === this.chartPointCount && outageKey === this.chartOutageKey) return;
        this.chartPointCount = points.length;
        this.chartOutageKey = outageKey;
        const labels = points.map((p) => clock(p.tS));
        const indexAt = (tS) => {
            let best = 0;
            points.forEach((p, i) => {
                if (Math.abs(p.tS - tS) < Math.abs(points[best].tS - tS)) best = i;
            });
            return best;
        };
        this.chart.data.labels = labels;
        this.chart.data.datasets[0].data = points.map((p) => p.throughput);
        this.chart.options.plugins.xRangeBand = points.length
            ? { bands: outages.map((o) => ({ from: indexAt(o.fromS), to: o.toS == null ? points.length - 1 : indexAt(o.toS) })), label: 'LIGHTS DARK' }
            : {};
        this.chart.update('none');
        this.chartEmpty?.classList.toggle('hidden', points.length > 0);
    }

    /** A 2-minute trend line, in ink: identity is the tile's label, not a colour. */
    _drawSpark(canvas, values) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (!width || !height) return;
        if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
        if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        const points = values.map((v, i) => [i, v]).filter(([, v]) => v != null && Number.isFinite(v));
        if (points.length < 2) return;
        let min = Math.min(...points.map(([, v]) => v));
        let max = Math.max(...points.map(([, v]) => v));
        if (max - min < 1e-9) {
            min -= 1;
            max += 1;
        }
        const span = Math.max(values.length - 1, 1);
        const x = (i) => 1 + (i / span) * (width - 4);
        const y = (v) => height - 2 - ((v - min) / (max - min)) * (height - 4);
        ctx.strokeStyle = INK.secondary;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        points.forEach(([i, v], n) => (n ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
        ctx.stroke();
        const [li, lv] = points[points.length - 1];
        ctx.fillStyle = INK.primary;
        ctx.beginPath();
        ctx.arc(x(li), y(lv), 1.8, 0, Math.PI * 2);
        ctx.fill();
    }
}

function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
}

function storedState() {
    try {
        const value = window.localStorage.getItem(STORAGE_KEY);
        return STATES.includes(value) ? value : 'collapsed';
    } catch {
        return 'collapsed';
    }
}

function storeState(value) {
    try {
        window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
        // Storage blocked: the panel still works, it just won't remember.
    }
}
