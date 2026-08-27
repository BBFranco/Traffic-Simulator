<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}" class="h-full">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="csrf-token" content="{{ csrf_token() }}">

        <title>{{ config('app.name') }}</title>

        @include('partials.theme-boot')

        <link rel="preconnect" href="https://fonts.bunny.net">
        <link href="https://fonts.bunny.net/css?family=figtree:400,500,600,700&display=swap" rel="stylesheet" />

        @vite(['resources/css/app.css', 'resources/js/app.js'])
    </head>
    <body class="h-full font-sans antialiased bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-200">
        <div class="min-h-full flex flex-col items-center justify-center px-4 py-12">
            <div class="flex flex-col items-center gap-3">
                <a href="/" class="flex items-center gap-3">
                    <x-application-logo class="h-11 w-11" />
                    <span class="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">{{ config('app.name') }}</span>
                </a>
                <p class="max-w-sm text-center text-xs leading-relaxed text-slate-500">
                    Fixed-time vs. sensor-adaptive signal control under load shedding
                </p>
            </div>

            <div class="mt-8 w-full sm:max-w-md rounded-xl border border-slate-200 bg-white px-6 py-6 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:shadow-xl dark:shadow-black/30">
                {{ $slot }}
            </div>

            <div class="mt-6">
                <x-theme-toggle />
            </div>
        </div>
    </body>
</html>
