@props(['title', 'subtitle' => null])

<section class="border-b border-slate-200 px-4 py-4 dark:border-slate-800">
    <h3 class="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{{ $title }}</h3>
    @if ($subtitle)
        <p class="mt-1 text-[11px] leading-relaxed text-slate-500">{{ $subtitle }}</p>
    @endif
    <div class="mt-3 space-y-3">
        {{ $slot }}
    </div>
</section>
