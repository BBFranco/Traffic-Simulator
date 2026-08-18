<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}" class="h-full">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="csrf-token" content="{{ csrf_token() }}">

        <title>{{ $title ? $title.' · '.config('app.name') : config('app.name') }}</title>

        @include('partials.theme-boot')

        <link rel="preconnect" href="https://fonts.bunny.net">
        <link href="https://fonts.bunny.net/css?family=figtree:400,500,600,700&display=swap" rel="stylesheet" />

        @vite(['resources/css/app.css', 'resources/js/app.js'])
        @stack('head')
    </head>
    <body class="h-full font-sans antialiased bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-200">
        {{--
            A flush page (the simulator) is pinned to the viewport from `lg` up so
            the canvas and the stats footer are both on screen and the control rail
            scrolls inside itself. Below `lg` the columns stack and the page scrolls
            normally.
        --}}
        <div class="min-h-full flex flex-col {{ $flush ? 'lg:h-full lg:overflow-hidden' : '' }}">
            @include('layouts.navigation')

            @isset($header)
                <header class="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60">
                    <div class="{{ $wide ? 'w-full px-4 sm:px-6 lg:px-8' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8' }} py-5">
                        {{ $header }}
                    </div>
                </header>
            @endisset

            <main class="flex-1 flex flex-col min-h-0 {{ $flush ? '' : 'py-8' }}">
                <div class="{{ $flush ? 'flex-1 flex flex-col min-h-0 w-full' : ($wide ? 'w-full px-4 sm:px-6 lg:px-8' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 w-full') }}">
                    {{ $slot }}
                </div>
            </main>
        </div>
        @stack('scripts')
    </body>
</html>
