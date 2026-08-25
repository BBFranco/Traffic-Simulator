{{--
    /builder - road network editor.

    Every road here is drawn from scratch on the canvas by builder.js - nothing
    is loaded from corridors/*.json. Placing, resizing (lane count) and joining
    roads all happen client-side; there is nothing to persist yet.
--}}
<x-app-layout title="Builder" wide flush>
    <div class="flex flex-1 min-h-0 flex-col lg:flex-row">

        {{-- ============================================================ RAIL --}}
        <aside class="w-full lg:w-[336px] shrink-0 overflow-y-auto border-b border-slate-200 bg-slate-50 lg:border-b-0 lg:border-r dark:border-slate-800 dark:bg-slate-900">

            <x-control-section title="Road type" subtitle="Pick a direction, then drag a road onto the map.">
                <x-segmented control="roadType" size="sm" value="twoway"
                             :options="['oneway' => 'One-way', 'twoway' => 'Two-way']" />
            </x-control-section>

            <x-control-section title="Lanes" subtitle="Applies to the next road you place or connect.">
                <div class="flex items-center gap-2">
                    <button type="button" id="builder-lanes-dec"
                            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white text-sm text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
                        &minus;
                    </button>
                    <div id="builder-lanes-value" class="flex-1 text-center font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">3</div>
                    <button type="button" id="builder-lanes-inc"
                            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-300 bg-white text-sm text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
                        +
                    </button>
                </div>
            </x-control-section>

            <x-control-section title="Palette" subtitle="Drag a road onto the map to place it.">
                <div id="builder-palette-tile" draggable="true"
                     class="flex cursor-grab items-center gap-2.5 rounded-md border border-slate-200 bg-slate-50/80 p-2.5 transition hover:border-slate-300 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:border-slate-700">
                    <svg width="40" height="40" viewBox="0 0 40 40" class="shrink-0">
                        <rect x="4" y="14" width="32" height="12" rx="1.5" class="fill-slate-400 dark:fill-slate-600" />
                        <rect x="5" y="15" width="30" height="10" rx="1.2" class="fill-slate-200 dark:fill-slate-700" />
                        <line x1="5" y1="20" x2="35" y2="20" class="stroke-amber-600 dark:stroke-amber-500" stroke-width="1.2" />
                    </svg>
                    <div class="min-w-0">
                        <div class="text-xs font-medium text-slate-800 dark:text-slate-200">New road</div>
                        <div id="builder-palette-meta" class="text-[10px] text-slate-500">3 lanes · Two-way</div>
                    </div>
                    <svg width="14" height="20" viewBox="0 0 14 20" class="ms-auto shrink-0 text-slate-400 dark:text-slate-600">
                        <circle cx="3" cy="4" r="1.4" fill="currentColor" /><circle cx="3" cy="10" r="1.4" fill="currentColor" /><circle cx="3" cy="16" r="1.4" fill="currentColor" />
                        <circle cx="11" cy="4" r="1.4" fill="currentColor" /><circle cx="11" cy="10" r="1.4" fill="currentColor" /><circle cx="11" cy="16" r="1.4" fill="currentColor" />
                    </svg>
                </div>
            </x-control-section>

            <x-control-section title="Connections" subtitle="Every road exposes a connection point every 10 m. Drag from any point to branch a new road at any angle - release to join it. Joined points fill in solid and get a junction plate where the roads meet.">
                <div class="space-y-1.5">
                    <div class="flex items-center gap-2">
                        <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="4" class="fill-white stroke-slate-500 dark:fill-slate-900 dark:stroke-slate-400" stroke-width="1.6" /></svg>
                        <span class="text-[11px] text-slate-500 dark:text-slate-400">Open connection point</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="4" class="fill-sky-600 dark:fill-sky-500" /></svg>
                        <span class="text-[11px] text-slate-500 dark:text-slate-400">Joined - a road connects here</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="4.5" class="fill-sky-600 dark:fill-sky-500" opacity="0.55" /></svg>
                        <span class="text-[11px] text-slate-500 dark:text-slate-400">Point being dragged to set an angle</span>
                    </div>
                </div>
            </x-control-section>

            <div class="px-4 py-4">
                <span id="builder-status" class="text-[10px] text-slate-400 dark:text-slate-600">0 segments · 0 junctions</span>
            </div>
        </aside>

        {{-- ========================================================== CANVAS --}}
        <div class="flex min-w-0 flex-1 flex-col">

            <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/70">
                <span class="text-xs font-semibold text-slate-900 dark:text-slate-100">Map</span>
                <button type="button" id="builder-reset"
                        class="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
                    Reset
                </button>
                <span class="ms-auto inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-400">
                    <span id="builder-road-count">2</span> roads
                </span>
            </div>

            <div id="builder-canvas-wrap" class="relative min-h-[340px] flex-1 bg-slate-50 dark:bg-slate-950">
                <canvas id="builder-canvas" class="block h-full w-full cursor-crosshair"></canvas>

                <div id="builder-pin"
                     class="absolute hidden w-[176px] rounded-md border border-slate-300 bg-white p-2.5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
                    <div class="flex items-center justify-between gap-2">
                        <span id="builder-pin-type" class="text-[9px] font-semibold uppercase tracking-wide text-slate-500"></span>
                        <button type="button" id="builder-pin-done" class="text-[11px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">Done</button>
                    </div>
                    <div class="mt-2 flex items-center gap-2">
                        <label for="builder-pin-lanes" class="text-[11px] text-slate-600 dark:text-slate-400">Lanes</label>
                        <input type="number" id="builder-pin-lanes" min="1" max="6"
                               class="w-12 rounded border-slate-300 bg-white py-0.5 text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
                    </div>
                </div>

                <div id="builder-angle-badge" class="hidden"></div>

                <div class="pointer-events-none absolute bottom-3 right-3 rounded-md border border-slate-200 bg-white/85 px-2.5 py-1.5 text-[10px] text-slate-500 backdrop-blur dark:border-slate-800 dark:bg-slate-900/85">
                    Drag a road onto the map · drag a connection point to branch and join at an angle
                </div>
            </div>
        </div>
    </div>

    @vite('resources/js/builder.js')
</x-app-layout>
