@props(['status'])

@if ($status)
    <div {{ $attributes->merge(['class' => 'font-medium text-sm text-emerald-700 dark:text-emerald-400']) }}>
        {{ $status }}
    </div>
@endif
