<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}" class="h-full">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>{{ config('app.name') }}</title>
        @include('partials.theme-boot')
        <link rel="preconnect" href="https://fonts.bunny.net">
        <link href="https://fonts.bunny.net/css?family=figtree:400,500,600,700&display=swap" rel="stylesheet" />
        @vite(['resources/css/app.css', 'resources/js/app.js'])
    </head>
    <body class="h-full font-sans antialiased bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-200">
        <div class="min-h-full flex flex-col">
            <header class="border-b border-slate-200 dark:border-slate-800">
                <div class="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
                    <div class="flex items-center gap-3">
                        <x-application-logo class="h-8 w-8" />
                        <span class="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">{{ config('app.name') }}</span>
                    </div>
                    <nav class="flex items-center gap-2">
                        <x-theme-toggle />
                        @auth
                            <a href="{{ route('simulator') }}" class="rounded-md bg-sky-600 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white transition hover:bg-sky-500 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400">Open simulator</a>
                        @else
                            <a href="{{ route('login') }}" class="rounded-md px-4 py-2 text-sm font-medium text-slate-600 transition hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100">Log in</a>
                            @if (Route::has('register'))
                                <a href="{{ route('register') }}" class="rounded-md bg-sky-600 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white transition hover:bg-sky-500 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400">Register</a>
                            @endif
                        @endauth
                    </nav>
                </div>
            </header>

            <main class="flex-1">
                <div class="max-w-6xl mx-auto px-6 py-16 sm:py-24">
                    <span class="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:border-slate-700 dark:bg-slate-900">
                        IoT-enabled smart traffic management
                    </span>

                    <h1 class="mt-6 max-w-3xl text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-5xl dark:text-slate-50">
                        Does adaptive signal control still help when the power goes out?
                    </h1>

                    <p class="mt-6 max-w-2xl text-base leading-relaxed text-slate-600 dark:text-slate-400">
                        A browser-based traffic simulator that runs fixed-time, sensor-adaptive and green-wave
                        signal control over the same corridor and the same seeded traffic, then cuts the power
                        mid-run to see which assumptions survive. Modelled on Pretorius Street and Francis Baard
                        Street into Hatfield, Pretoria.
                    </p>

                    <div class="mt-10 flex flex-wrap items-center gap-3">
                        @auth
                            <a href="{{ route('simulator') }}" class="rounded-md bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400">Open the simulator</a>
                            <a href="{{ route('results') }}" class="rounded-md border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">View results</a>
                        @else
                            <a href="{{ route('login') }}" class="rounded-md bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400">Log in to run it</a>
                            @if (Route::has('register'))
                                <a href="{{ route('register') }}" class="rounded-md border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">Create an account</a>
                            @endif
                        @endauth
                    </div>

                    <dl class="mt-16 grid gap-4 sm:grid-cols-3">
                        @foreach ([
                            ['Fixed-time baseline', "Cycle length and phase splits from Webster's method (1958), so the \"dumb\" comparator is a legitimate implementation rather than a strawman."],
                            ['Sensor-adaptive control', 'A gap-extension heuristic over four sensor models, mirroring the sense-decide-execute loop used by SCATS and SCOOT.'],
                            ['Load shedding', 'Lights go dark, high-power sensors drop out, intersections fall back to all-way-stop, and each mode degrades differently.'],
                        ] as [$term, $detail])
                            <div class="rounded-xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-800 dark:bg-slate-900/60">
                                <dt class="text-sm font-semibold text-slate-900 dark:text-slate-100">{{ $term }}</dt>
                                <dd class="mt-2 text-[13px] leading-relaxed text-slate-600 dark:text-slate-400">{{ $detail }}</dd>
                            </div>
                        @endforeach
                    </dl>
                </div>
            </main>

            <footer class="border-t border-slate-200 dark:border-slate-800">
                <div class="max-w-6xl mx-auto px-6 py-6 text-xs text-slate-500">
                    Vehicle dynamics use the Intelligent Driver Model (Treiber, Hennig &amp; Helbing, 2000).
                    Laravel {{ Illuminate\Foundation\Application::VERSION }} · PHP {{ PHP_VERSION }}
                </div>
            </footer>
        </div>
    </body>
</html>
