{{--
    On-brand loading indicator: three signal lenses (same red/amber/green as
    <x-application-logo>) chasing left to right, standing in for the plain
    spinner previously used on the Traffic Counter "Processing..." status and
    the Results "Running" badge - both are genuinely traffic-themed waits, so
    this reuses the app's own logo palette instead of a generic spinner.
--}}
{{-- No default size class: Blade's merge() always concatenates rather than
     replaces 'class', so a caller-supplied width/height utility would sit
     alongside a default one instead of overriding it. Callers pass sizing
     explicitly (e.g. `class="h-4 w-11"`). --}}
<svg viewBox="0 0 60 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {{ $attributes }}>
    <circle cx="10" cy="10" r="7" fill="#E5484D" class="traffic-loader-dot" style="animation-delay: 0ms" />
    <circle cx="30" cy="10" r="7" fill="#F0A93A" class="traffic-loader-dot" style="animation-delay: 200ms" />
    <circle cx="50" cy="10" r="7" fill="#1E8F5A" class="traffic-loader-dot" style="animation-delay: 400ms" />
</svg>
