/**
 * tooltips.js - one shared hover/focus popover for every `[data-tip]` element.
 *
 * Fixed-positioned on <body> rather than nested in the trigger, so it is never
 * clipped by an `overflow-y-auto` container like the simulator's control rail.
 * Delegated listeners mean rows the page clones at runtime get tooltips too.
 */
const GAP_PX = 6;
const EDGE_PX = 8;

let popover = null;
let activeTrigger = null;

function ensurePopover() {
    if (popover) return popover;
    popover = document.createElement('div');
    popover.setAttribute('role', 'tooltip');
    popover.className =
        'pointer-events-none fixed z-50 hidden max-w-[260px] rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-600 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300';
    document.body.append(popover);
    return popover;
}

function show(trigger) {
    const text = trigger.dataset.tip;
    if (!text) return;
    const tip = ensurePopover();
    activeTrigger = trigger;
    tip.textContent = text;
    tip.classList.remove('hidden');

    const anchor = trigger.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    const left = Math.min(Math.max(anchor.left, EDGE_PX), window.innerWidth - box.width - EDGE_PX);
    const below = anchor.bottom + GAP_PX;
    const top = below + box.height > window.innerHeight - EDGE_PX ? anchor.top - box.height - GAP_PX : below;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(EDGE_PX, top)}px`;
}

function hide() {
    activeTrigger = null;
    popover?.classList.add('hidden');
}

export function initTooltips(root = document) {
    root.addEventListener('pointerover', (event) => {
        const trigger = event.target.closest?.('[data-tip]');
        if (trigger && trigger !== activeTrigger) show(trigger);
    });
    root.addEventListener('pointerout', (event) => {
        if (!activeTrigger) return;
        if (event.relatedTarget && activeTrigger.contains(event.relatedTarget)) return;
        if (event.target.closest?.('[data-tip]') === activeTrigger) hide();
    });
    root.addEventListener('focusin', (event) => {
        const trigger = event.target.closest?.('[data-tip]');
        if (trigger) show(trigger);
    });
    root.addEventListener('focusout', hide);
    window.addEventListener('scroll', hide, true);
}
