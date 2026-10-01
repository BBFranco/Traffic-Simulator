{{--
    Small "i" button whose explanation shows on hover/focus. The popover itself is
    one shared fixed-position element driven by resources/js/tooltips.js, so it is
    never clipped by the scrolling control rail.
--}}
<button type="button"
        data-tip="{{ $text }}"
        aria-label="{{ $text }}"
        {{ $attributes->merge(['class' => 'inline-flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border border-slate-300 text-[9px] font-semibold normal-case leading-none tracking-normal text-slate-400 transition hover:border-sky-500 hover:text-sky-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-slate-600 dark:text-slate-500 dark:hover:border-sky-400 dark:hover:text-sky-400']) }}>i</button>
