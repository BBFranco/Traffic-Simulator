/**
 * The Results page's report: the same sections, tables and charts the PDF export prints (resultsPdf.js), drawn as HTML.
 *
 * The PDF's section drawers write to a `report` object (resultsPdf.js's Report: sectionTitle, heading, paragraph,
 * chartCard, table...). HtmlReport below is that same interface over the DOM, so the page reuses every drawer as is
 * and can't drift from the PDF. Each numbered section is a collapsible panel, built the first time it is opened -
 * a section renders a few dozen chart images, so the page only pays for the ones the viewer reads. Inside a section
 * each subsection (1.1 Total, 1.2 Main arterial ...) is collapsible too.
 *
 * Chart images keep the PDF's light print palette on a white card in both themes.
 */
import { applyChartTheme } from './charts/theme.js';
import { currentTheme } from './theme.js';
import { ZONE_TINTS } from './sim/renderer.js';
import { drawDetailedAppendix } from './resultsAppendix.js';
import {
    COLOURS,
    CONTENT_WIDTH,
    OUTAGES,
    SCOPES,
    SECTION,
    ZONE_LEGEND_NOTE,
    buildVariants,
    comparisonTable,
    corridorCaption,
    corridorLayoutImage,
    coverFacts,
    drawCoordination,
    drawMethodNotes,
    drawOutageSection,
    drawRichness,
    fetchAppendixRuns,
    renderChartImage,
    timelineFor,
} from './resultsPdf.js';

const TONE_CLASSES = {
    better: 'bg-emerald-50 font-semibold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
    worse: 'bg-rose-50 font-semibold text-rose-700 dark:bg-rose-500/10 dark:text-rose-300',
};
const CARD = 'rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';
/** The chevron turns when its own <details> opens. Literal per group - Tailwind only sees complete class names. */
const CHEVRON_ROTATE = { section: 'group-open/section:rotate-90', sub: 'group-open/sub:rotate-90', layout: 'group-open/layout:rotate-90' };
const chevron = (group, extra = '') =>
    `<svg class="${CHEVRON_ROTATE[group]} h-4 w-4 shrink-0 text-slate-400 transition-transform ${extra}" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clip-rule="evenodd" /></svg>`;

/** `el('div', 'classes', text)` - text is set as text, never parsed as HTML. */
function el(tag, className = '', text = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function swatch(colour) {
    const mark = el('span', 'inline-block h-3 w-3 shrink-0 rounded-sm');
    mark.style.backgroundColor = colour;
    return mark;
}

/** A white figure card holding one print-palette chart image. */
function figure(image, alt) {
    const frame = el('div', 'max-w-4xl rounded-md bg-white p-2 ring-1 ring-slate-200 dark:ring-slate-700');
    const img = el('img', 'block h-auto w-full');
    img.src = image;
    img.alt = alt;
    img.loading = 'lazy';
    frame.appendChild(img);
    return frame;
}

/**
 * resultsPdf.js's Report, drawn into the DOM. Page geometry (newPage, ensureSpace, y) means nothing here, so those are
 * no-ops; a sub-level heading opens a new collapsible subsection and everything after it lands inside.
 */
class HtmlReport {
    constructor(root, { onSectionTitle = null } = {}) {
        this.root = root;
        this.current = root;
        this.onSectionTitle = onSectionTitle;
        this.section = null;
        this.sub = 0;
        this.card = 0;
        this.y = 0;
    }

    /** Same numbering as resultsPdf.js's Report.numbered(). */
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

    newPage() {}

    ensureSpace() {}

    /** The panel's summary already shows the title; the drawer's own subtitle (e.g. the appendix's run count) updates it. */
    sectionTitle(title, subtitle, number = null) {
        this.section = number;
        this.sub = 0;
        this.card = 0;
        this.current = this.root;
        this.onSectionTitle?.(title, subtitle);
    }

    heading(title, caption, { level = 'sub', swatch: tint = null } = {}) {
        title = this.numbered(title, level);
        if (level === 'sub' && this.section != null) {
            const details = el('details', `group/sub ${CARD}`);
            // The first subsection of a section opens with it, the rest stay folded.
            details.open = this.sub === 1;
            const summary = el('summary', 'flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800/60 [&::-webkit-details-marker]:hidden');
            summary.insertAdjacentHTML('beforeend', chevron('sub'));
            if (tint) summary.appendChild(swatch(tint));
            summary.appendChild(el('span', '', title));
            details.appendChild(summary);
            const body = el('div', 'space-y-4 border-t border-slate-200 px-4 py-4 dark:border-slate-800');
            if (caption) body.appendChild(el('p', 'text-xs leading-relaxed text-slate-500 dark:text-slate-400', caption));
            details.appendChild(body);
            this.root.appendChild(details);
            this.current = body;
            return;
        }
        const block = el('div', 'space-y-1 pt-2');
        const head = el('h4', 'flex items-center gap-2 text-[13px] font-semibold text-slate-900 dark:text-slate-100');
        if (tint) head.appendChild(swatch(tint));
        head.appendChild(el('span', '', title));
        block.appendChild(head);
        if (caption) block.appendChild(el('p', 'text-xs leading-relaxed text-slate-500 dark:text-slate-400', caption));
        this.current.appendChild(block);
    }

    paragraph(text) {
        this.current.appendChild(el('p', 'whitespace-pre-line text-xs leading-relaxed text-slate-600 dark:text-slate-300', text));
    }

    image(dataUrl) {
        this.current.appendChild(figure(dataUrl, ''));
    }

    chartCard(title, caption, dataUrl) {
        title = this.numbered(title, 'card');
        const card = el('figure', 'space-y-2');
        card.appendChild(el('figcaption', 'text-[13px] font-semibold text-slate-900 dark:text-slate-100', title));
        if (caption) card.appendChild(el('p', 'text-[11px] text-slate-500 dark:text-slate-400', caption));
        card.appendChild(figure(dataUrl, title));
        this.current.appendChild(card);
    }

    /** Side-by-side chart cards (the time-to-recovery pair) - titles come numbered from the drawer. */
    chartRow(charts) {
        const row = el('div', 'grid gap-4 lg:grid-cols-2');
        charts.forEach((chart) => {
            const card = el('figure', 'space-y-2');
            card.appendChild(el('figcaption', 'text-[13px] font-semibold text-slate-900 dark:text-slate-100', chart.title));
            chart.captions.forEach((caption) => card.appendChild(el('p', 'text-[11px] text-slate-500 dark:text-slate-400', caption)));
            if (chart.image) card.appendChild(figure(chart.image, chart.title));
            if (chart.warning) card.appendChild(el('p', 'text-[11px] text-rose-700 dark:text-rose-300', chart.warning));
            row.appendChild(card);
        });
        this.current.appendChild(row);
    }

    /** A jspdf-autotable options object ({head, body, columnStyles, didParseCell}) as an HTML table. */
    table({ head = [], body = [], columnStyles = {}, didParseCell = null }) {
        const wrap = el('div', 'overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800');
        const table = el('table', 'w-full text-left text-xs');
        const alignOf = (index, styles) => (styles?.halign ?? columnStyles[index]?.halign) === 'right' ? 'text-right' : styles?.halign === 'center' ? 'text-center' : 'text-left';

        const thead = el('thead', 'bg-slate-50 text-[11px] text-slate-500 dark:bg-slate-800/60 dark:text-slate-400');
        head.forEach((headRow) => {
            const tr = el('tr');
            let column = 0;
            headRow.forEach((cell) => {
                const spec = typeof cell === 'object' && cell !== null ? cell : { content: cell };
                const th = el('th', `px-3 py-2 font-semibold align-bottom ${alignOf(column, spec.styles)}`, String(spec.content ?? ''));
                th.scope = 'col';
                if (spec.colSpan) th.colSpan = spec.colSpan;
                if (spec.rowSpan) th.rowSpan = spec.rowSpan;
                tr.appendChild(th);
                column += spec.colSpan ?? 1;
            });
            thead.appendChild(tr);
        });
        table.appendChild(thead);

        const tbody = el('tbody', 'divide-y divide-slate-100 tabular-nums text-slate-700 dark:divide-slate-800 dark:text-slate-200');
        body.forEach((bodyRow, rowIndex) => {
            const tr = el('tr', 'hover:bg-slate-50/70 dark:hover:bg-slate-800/40');
            bodyRow.forEach((cell, columnIndex) => {
                const spec = typeof cell === 'object' && cell !== null ? cell : { content: cell };
                // The drawers tint deltas through autotable's didParseCell; run it on a stand-in cell and read the tint back.
                const hookCell = { raw: cell, text: [String(spec.content ?? '')], styles: { ...(spec.styles ?? {}) } };
                didParseCell?.({ section: 'body', column: { index: columnIndex }, row: { index: rowIndex, raw: bodyRow }, cell: hookCell });
                const tone = hookCell.styles.fillColor === COLOURS.better ? TONE_CLASSES.better : hookCell.styles.fillColor === COLOURS.worse ? TONE_CLASSES.worse : '';
                const td = el('td', `whitespace-pre-line px-3 py-1.5 align-top ${alignOf(columnIndex, spec.styles)} ${tone}`, String(spec.content ?? ''));
                if (spec.colSpan) td.colSpan = spec.colSpan;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        this.current.appendChild(wrap);
    }

    headedTable(title, caption, options) {
        this.heading(title, caption, { level: 'card' });
        this.table(options);
    }
}

/** Runs a drawer with the print palette on, so chart images match the PDF; the page's own charts get the theme back. */
async function withPrintCharts(draw) {
    applyChartTheme('light');
    try {
        return await draw();
    } finally {
        applyChartTheme(currentTheme());
    }
}

/**
 * One collapsible top-level section. `build(report)` runs the first time it opens. Returns the <details> so the
 * section nav can open and scroll to it.
 */
function sectionPanel(container, { number, title, subtitle, build }) {
    const details = el('details', `group/section scroll-mt-16 ${CARD}`);
    const summary = el('summary', 'flex cursor-pointer list-none items-start gap-3 px-5 py-4 hover:bg-slate-50 dark:hover:bg-slate-800/60 [&::-webkit-details-marker]:hidden');
    summary.insertAdjacentHTML('beforeend', chevron('section', 'mt-1'));
    const badge = el('span', 'mt-0.5 inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-sky-600 px-1.5 text-xs font-bold text-white dark:bg-sky-500 dark:text-slate-950', number == null ? 'A' : String(number));
    summary.appendChild(badge);
    const text = el('div', 'min-w-0');
    text.appendChild(el('h2', 'text-base font-semibold text-slate-900 dark:text-slate-100', title));
    const sub = el('p', 'mt-0.5 text-xs text-slate-500 dark:text-slate-400', subtitle ?? '');
    text.appendChild(sub);
    summary.appendChild(text);
    details.appendChild(summary);

    const body = el('div', 'space-y-3 border-t border-slate-200 px-5 py-5 dark:border-slate-800');
    details.appendChild(body);

    let built = false;
    details.addEventListener('toggle', () => {
        if (!details.open || built) return;
        built = true;
        body.replaceChildren(el('p', 'text-xs text-slate-500 dark:text-slate-400', 'Building this section…'));
        // A frame first, so the "Building" line paints before the charts block the thread.
        requestAnimationFrame(() =>
            setTimeout(async () => {
                const content = el('div', 'space-y-3');
                const report = new HtmlReport(content, { onSectionTitle: (_, subtitle) => subtitle && (sub.textContent = subtitle) });
                try {
                    await withPrintCharts(() => build(report));
                    body.replaceChildren(content);
                } catch (error) {
                    built = false;
                    body.replaceChildren(el('p', 'text-xs text-rose-700 dark:text-rose-300', `This section could not be drawn: ${error.message}`));
                }
            }, 0)
        );
    });
    container.appendChild(details);
    return details;
}

/** The PDF cover's content: the batch line, stat cards, schedule, variant key and the headline table. */
function drawOverview(container, data, variants, { corridorUrl }) {
    const { stats, coverLines } = coverFacts(data);
    const overview = el('div', `space-y-5 p-5 ${CARD}`);

    const header = el('div', 'space-y-1');
    header.appendChild(el('p', 'text-[10px] font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-400', 'Results report'));
    header.appendChild(el('h2', 'text-lg font-semibold text-slate-900 dark:text-slate-100', 'Does ITS beat the fixed-time baseline? Every scope, every controller variant.'));
    if (data.batchStamp?.label) header.appendChild(el('p', 'text-[11px] leading-relaxed text-slate-500 dark:text-slate-400', `Batch: ${data.batchStamp.label}`));
    overview.appendChild(header);

    const tiles = el('dl', 'grid grid-cols-2 gap-3 lg:grid-cols-4');
    stats.forEach(([label, value]) => {
        const tile = el('div', 'rounded-md border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/50');
        tile.appendChild(el('dt', 'text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400', label));
        tile.appendChild(el('dd', 'mt-1 text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100', value));
        tiles.appendChild(tile);
    });
    overview.appendChild(tiles);
    coverLines.forEach((line) => overview.appendChild(el('p', 'text-xs text-slate-600 dark:text-slate-300', line)));

    const key = el('div', 'space-y-2');
    key.appendChild(el('h3', 'text-sm font-semibold text-slate-900 dark:text-slate-100', 'Controller variants'));
    key.appendChild(el('p', 'text-xs text-slate-500 dark:text-slate-400', 'Colour follows the variant on every chart. Adaptive and coordinated adaptive are each broken out per sensor model as well as the blended average across sensors.'));
    const list = el('ul', 'grid gap-x-6 gap-y-1.5 text-xs text-slate-700 sm:grid-cols-2 xl:grid-cols-3 dark:text-slate-200');
    variants.forEach((variant) => {
        const item = el('li', 'flex items-center gap-2');
        item.appendChild(swatch(variant.colour));
        item.appendChild(el('span', '', variant.label));
        list.appendChild(item);
    });
    key.appendChild(list);
    overview.appendChild(key);

    const headline = el('div', 'space-y-2');
    const report = new HtmlReport(headline);
    report.heading(
        'Headline - ITS vs fixed-time (Total scope)',
        `Paired against Webster-timed fixed-time control on the same seeds and power state; ± is the 95% CI on the per-seed differences. Wait (mean, median, P95): negative is better. Throughput and cleared-without-stopping: positive is better. Every sensor on its own and every scope follow in the sections below.`,
        { level: 'card' }
    );
    comparisonTable(report, data, variants, SCOPES[0], { compact: true, powers: data.powerStates });
    overview.appendChild(headline);

    if (corridorUrl) {
        const layout = el('details', 'group/layout rounded-md border border-slate-200 dark:border-slate-800');
        const summary = el('summary', 'flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800/60 [&::-webkit-details-marker]:hidden');
        summary.insertAdjacentHTML('beforeend', chevron('layout'));
        summary.appendChild(el('span', '', 'Corridor layout'));
        layout.appendChild(summary);
        const body = el('div', 'space-y-3 border-t border-slate-200 px-4 py-4 dark:border-slate-800');
        layout.appendChild(body);
        let loaded = false;
        layout.addEventListener('toggle', async () => {
            if (!layout.open || loaded) return;
            loaded = true;
            body.replaceChildren(el('p', 'text-xs text-slate-500 dark:text-slate-400', 'Drawing the layout…'));
            const drawn = await corridorLayoutImage(corridorUrl).catch(() => null);
            if (!drawn) {
                body.replaceChildren(el('p', 'text-xs text-slate-500 dark:text-slate-400', 'The layout could not be drawn.'));
                return;
            }
            body.replaceChildren(el('p', 'text-xs text-slate-500 dark:text-slate-400', corridorCaption(drawn, data)), figure(drawn.image, 'Corridor layout'));
            if (drawn.zoned) {
                const zones = el('ul', 'flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-700 dark:text-slate-200');
                [[1, 'Zone 1 south'], [2, 'Zone 2 middle'], [3, 'Zone 3 north']].forEach(([zone, label]) => {
                    const item = el('li', 'flex items-center gap-2');
                    item.appendChild(swatch(ZONE_TINTS[zone]));
                    item.appendChild(el('span', '', label));
                    zones.appendChild(item);
                });
                body.append(zones, el('p', 'text-[11px] text-slate-500 dark:text-slate-400', ZONE_LEGEND_NOTE));
            }
        });
        overview.appendChild(layout);
    }

    container.appendChild(overview);
}

/** Pills that open a section and scroll to it, plus collapse-all. */
function drawSectionNav(container, panels) {
    const nav = el('nav', 'sticky top-0 z-20 -mx-1 flex flex-wrap items-center gap-2 bg-white/90 px-1 py-2 backdrop-blur dark:bg-slate-950/90');
    nav.setAttribute('aria-label', 'Report sections');
    panels.forEach(({ number, title, details }) => {
        const pill = el('button', 'inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 transition hover:border-sky-400 hover:text-sky-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-sky-500 dark:hover:text-sky-300');
        pill.type = 'button';
        pill.appendChild(el('span', 'font-bold text-sky-700 dark:text-sky-400', number == null ? 'A' : String(number)));
        pill.appendChild(el('span', '', title));
        pill.addEventListener('click', () => {
            details.open = true;
            details.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        nav.appendChild(pill);
    });
    const collapse = el('button', 'ms-auto rounded-md px-2.5 py-1 text-xs font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100', 'Collapse all');
    collapse.type = 'button';
    collapse.addEventListener('click', () => panels.forEach(({ details }) => (details.open = false)));
    nav.appendChild(collapse);
    container.appendChild(nav);
}

/**
 * Draws the whole report into `container` from the page's live results payload - the same `data` the PDF export reads.
 * Called again after a filter change refreshes the payload.
 */
export function renderReportView(container, data, { corridorUrl = null, appendixRunsUrl = null } = {}) {
    if (!container) return;
    container.replaceChildren();
    if (!data.aggregates?.length) {
        container.appendChild(el('p', `p-5 text-sm text-slate-500 dark:text-slate-400 ${CARD}`, 'No batch results for this selection yet.'));
        return;
    }

    const variants = buildVariants(data);
    // Every run of the batch, fetched once and only when a section that needs it (sensor richness, appendix) opens.
    let appendixRuns = null;
    const runs = () => (appendixRuns ??= appendixRunsUrl ? fetchAppendixRuns(appendixRunsUrl).catch(() => null) : Promise.resolve(null));
    const hasRichness = data.aggregates.some((row) => row.controller_mode === 'adaptive_rich');

    drawOverview(container, data, variants, { corridorUrl });

    const sections = [
        ...['load_shedding', 'rolling_blackout'].map((power) => ({
            number: SECTION[power],
            title: OUTAGES[power].title,
            subtitle: OUTAGES[power].subtitle,
            build: (report) => drawOutageSection(report, data, variants, power),
        })),
        {
            number: SECTION.coordination,
            title: 'Coordination',
            subtitle: 'Coordinated adaptive only - what the coordination layers did over the measured window',
            build: (report) => drawCoordination(report, data, data.coordinationMetrics, SECTION.coordination),
        },
        ...(hasRichness
            ? [
                  {
                      number: SECTION.methodNotes,
                      title: 'Sensor richness',
                      subtitle: 'Does the controller gain from what a richer sensor reports?',
                      build: async (report) => {
                          const all = await runs();
                          if (!all?.length || !drawRichness(report, all, data, SECTION.methodNotes)) report.paragraph('No sensor-richness runs in this selection.');
                      },
                  },
              ]
            : []),
        {
            number: SECTION.methodNotes + (hasRichness ? 1 : 0),
            title: 'Method notes',
            subtitle: 'How every figure above was measured, paired and capped',
            build: (report) => drawMethodNotes(report, data, SECTION.methodNotes + (hasRichness ? 1 : 0)),
        },
        {
            number: null,
            title: 'Appendix: detailed figures and tables',
            subtitle: 'Every figure and table recomputed run by run from this batch',
            build: async (report) => {
                const all = await runs();
                if (!all?.length) {
                    report.paragraph('The per-run data for the appendix could not be loaded.');
                    return;
                }
                await drawDetailedAppendix(report, all, data, { renderChartImage, timelineFor, contentWidthMm: CONTENT_WIDTH });
            },
        },
    ];

    const list = el('div', 'space-y-3');
    const panels = sections.map((section) => ({ ...section, details: sectionPanel(list, section) }));
    drawSectionNav(container, panels);
    container.appendChild(list);
}
