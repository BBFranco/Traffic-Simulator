/**
 * Light/dark theme.
 *
 * Light is the DEFAULT and is deliberately not derived from
 * `prefers-color-scheme` - a visitor with a dark OS still gets the white UI until
 * they ask for night mode. Once they choose, the choice is remembered.
 *
 * The class is applied by a tiny inline script in each layout's <head> so there
 * is no flash of the wrong theme before this module loads. This module owns the
 * toggle, the persistence and the change notification.
 */

const STORAGE_KEY = 'theme';
const DEFAULT_THEME = 'light';

/** Fired on `document` after the theme changes. `detail` is `{ theme }`. */
export const THEME_CHANGE_EVENT = 'theme:change';

export function storedTheme() {
    try {
        const value = localStorage.getItem(STORAGE_KEY);
        return value === 'dark' || value === 'light' ? value : null;
    } catch {
        return null;
    }
}

export function currentTheme() {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function applyTheme(theme, { persist = true, notify = true } = {}) {
    const next = theme === 'dark' ? 'dark' : 'light';
    const root = document.documentElement;

    root.classList.toggle('dark', next === 'dark');
    root.dataset.theme = next;
    // Keeps native controls, scrollbars and form widgets in step.
    root.style.colorScheme = next;

    if (persist) {
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // Private browsing or blocked storage: the theme still applies for this page.
        }
    }

    syncToggles(next);

    if (notify) {
        document.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme: next } }));
    }

    return next;
}

export function toggleTheme() {
    return applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

/** Run `callback(theme)` now and on every subsequent change. */
export function onThemeChange(callback) {
    callback(currentTheme());
    document.addEventListener(THEME_CHANGE_EVENT, (event) => callback(event.detail.theme));
}

function syncToggles(theme) {
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
        button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
        button.setAttribute('title', theme === 'dark' ? 'Switch to day mode' : 'Switch to night mode');
        button.setAttribute('aria-label', theme === 'dark' ? 'Switch to day mode' : 'Switch to night mode');
    });
}

function init() {
    // The inline head script already set the class; adopt it without re-persisting
    // or firing a change event nothing has subscribed to yet.
    applyTheme(storedTheme() ?? DEFAULT_THEME, { persist: false, notify: false });

    document.addEventListener('click', (event) => {
        if (event.target.closest('[data-theme-toggle]')) toggleTheme();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
