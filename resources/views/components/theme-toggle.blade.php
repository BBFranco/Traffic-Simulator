{{--
    Day/night toggle. resources/js/theme.js wires every `[data-theme-toggle]` on
    the page and keeps `aria-pressed` and the label in sync, so this needs no
    per-instance script.
--}}
<button type="button"
        data-theme-toggle
        aria-pressed="false"
        title="Switch to night mode"
        aria-label="Switch to night mode"
        {{ $attributes->merge(['class' => 'inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200']) }}>
    {{-- Moon: shown in day mode, i.e. "switch to night". --}}
    <svg class="h-4 w-4 dark:hidden" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M7.455 2.004a.75.75 0 0 1 .26.77 7 7 0 0 0 9.958 7.967.75.75 0 0 1 1.067.853A8.5 8.5 0 1 1 6.647 1.921a.75.75 0 0 1 .808.083Z" />
    </svg>
    {{-- Sun: shown in night mode, i.e. "switch to day". --}}
    <svg class="hidden h-4 w-4 dark:block" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M10 2a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 10 2ZM10 15a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 10 15ZM10 5.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM2.75 9.25a.75.75 0 0 0 0 1.5h1a.75.75 0 0 0 0-1.5h-1ZM15.25 9.25a.75.75 0 0 0 0 1.5h1a.75.75 0 0 0 0-1.5h-1ZM4.399 4.399a.75.75 0 0 1 1.06 0l.707.707a.75.75 0 0 1-1.06 1.06l-.708-.707a.75.75 0 0 1 0-1.06ZM13.834 13.834a.75.75 0 0 1 1.06 0l.707.707a.75.75 0 1 1-1.06 1.06l-.707-.706a.75.75 0 0 1 0-1.061ZM15.601 4.399a.75.75 0 0 1 0 1.06l-.707.708a.75.75 0 0 1-1.06-1.061l.706-.707a.75.75 0 0 1 1.061 0ZM6.166 13.834a.75.75 0 0 1 0 1.06l-.707.707a.75.75 0 0 1-1.06-1.06l.706-.707a.75.75 0 0 1 1.061 0Z" />
    </svg>
</button>
