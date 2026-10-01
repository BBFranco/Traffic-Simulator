@props(['title', 'info' => null, 'collapsible' => false])

{{-- `collapsible` sections need an `id`; the page script toggles `[data-section-body]` from the `[data-section-toggle]` header button. --}}
<section {{ $attributes->class('border-b border-slate-200 px-4 py-4 dark:border-slate-800') }}>
    <h3 class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
        @if ($collapsible)
            <button type="button" data-section-toggle aria-expanded="true"
                    class="group flex items-center gap-1.5 uppercase tracking-[0.08em] transition hover:text-slate-700 dark:hover:text-slate-300">
                <svg class="h-3 w-3 transition-transform group-aria-[expanded=false]:-rotate-90" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                    <path d="M3 4.5 6 7.5 9 4.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                {{ $title }}
            </button>
            <span data-section-summary class="hidden min-w-0 truncate font-medium normal-case tracking-normal text-slate-700 dark:text-slate-200"></span>
        @else
            {{ $title }}
        @endif
        @if ($info)
            <x-info-tip :text="$info" />
        @endif
    </h3>
    <div data-section-body class="mt-3 space-y-3">
        {{ $slot }}
    </div>
</section>
