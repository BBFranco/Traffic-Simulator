/**
 * Accordion behaviour for the /simulator control rail: every `<x-control-section collapsible>`
 * folds away behind its header, which then shows a one-line summary of the section's
 * current settings. Open/closed state is remembered per browser in localStorage.
 *
 * `summaries` maps a section id to a function returning its summary text; the module
 * re-runs them after any input/click in the rail, when the dynamic controls are rebuilt
 * and when the caller asks via the returned `refresh()` (programmatic changes such as a replay load).
 */

const STORAGE_KEY = 'sim.rail.collapsed';

function readCollapsed() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
    } catch {
        return {};
    }
}

function writeCollapsed(collapsed) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
    } catch {
        // Storage blocked or full: the rail still works, it just forgets.
    }
}

export function initRailAccordion(root, summaries) {
    const collapsed = readCollapsed();
    const sections = [...root.querySelectorAll('section[id]')].filter((section) => section.querySelector('[data-section-toggle]'));

    const render = (section) => {
        const isCollapsed = collapsed[section.id] === true;
        section.querySelector('[data-section-toggle]').setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
        section.querySelector('[data-section-body]').classList.toggle('hidden', isCollapsed);

        const summary = section.querySelector('[data-section-summary]');
        const text = isCollapsed ? (summaries[section.id]?.() ?? '') : '';
        const next = text ? `· ${text}` : '';
        if (summary.textContent !== next) summary.textContent = next;
        summary.classList.toggle('hidden', !text);
    };

    const refresh = () => sections.forEach(render);

    sections.forEach((section) => {
        section.querySelector('[data-section-toggle]').addEventListener('click', () => {
            collapsed[section.id] = collapsed[section.id] !== true;
            writeCollapsed(collapsed);
            render(section);
        });
    });

    // Handlers on the controls run first (listeners fire in registration order, and
    // the deferral below lets the rest of the click's work finish), then summaries re-read the DOM.
    let queued = false;
    const schedule = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            refresh();
        });
    };

    ['input', 'change', 'click'].forEach((type) => root.addEventListener(type, schedule));

    // Rebuilt per-corridor controls and segmented controls flipping their active face. The
    // summaries themselves and the demand "now" readouts (rewritten every frame) are ignored.
    const noisy = '[data-section-summary], [data-demand-now]';
    new MutationObserver((mutations) => {
        const relevant = mutations.some((mutation) => {
            const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
            return !target?.closest(noisy);
        });
        if (relevant) schedule();
    }).observe(root, { childList: true, subtree: true, attributeFilter: ['data-active'] });

    refresh();

    return { refresh };
}
