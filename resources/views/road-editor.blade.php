{{--
    /road-editor - the user's own road layouts (import, delete); opens on the
    whole corridor, and clicking an intersection runs
    it on its own with test traffic on every approach. There the lane arrows
    are clickable and save into the layout, along with any
    turn lanes. Driven by resources/js/roadEditor.js.
--}}
<x-app-layout title="Road Editor" wide flush>
    <div class="flex flex-1 min-h-0 flex-col lg:flex-row">

        {{-- ============================================================ RAIL --}}
        <aside class="w-full lg:w-[336px] shrink-0 overflow-y-auto border-b border-slate-200 bg-slate-50 lg:border-b-0 lg:border-r dark:border-slate-800 dark:bg-slate-900">

            <x-control-section id="editor-intersection-section" collapsible title="Intersection" info="Pick one of your road layouts, or import a new one from a corridor JSON file (same shape as the standard Hatfield layout). Whole corridor shows all of it running; pick an intersection - here or by clicking it on the map - and it runs on its own, with traffic arriving straight at it from every side, so you can see and edit how its lanes are used.">
                <div>
                    <label for="editor-corridor-select" class="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">Road layout</label>
                    <select id="editor-corridor-select" class="{{ $select }}">
                        @foreach ($corridors as $corridor)
                            <option value="{{ $corridor['id'] }}" @selected($corridor['id'] === $defaultCorridorId)>
                                {{ $corridor['name'] }}
                            </option>
                        @endforeach
                    </select>
                    <div class="mt-1.5 flex gap-1.5">
                        <button type="button" id="editor-import" title="Add a road layout from a corridor JSON file" class="{{ $buttonNeutral }}">Import layout…</button>
                        <button type="button" id="editor-delete-layout" title="Delete this layout from your account" class="rounded-md border border-rose-300 bg-white px-2.5 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-rose-500/40 dark:bg-slate-800 dark:text-rose-300 dark:hover:bg-rose-500/10">Delete</button>
                        <input type="file" id="editor-import-file" accept=".json,application/json" class="hidden">
                    </div>
                </div>
                <div id="editor-node-list" class="space-y-3"></div>
                <div id="editor-error" class="hidden rounded-md border border-rose-300 bg-rose-50 p-2.5 text-[11px] text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300"></div>
            </x-control-section>

            <x-control-section title="Turn lanes" info="Add a short extra lane beside the stop line for turning traffic - a left turn lane on the kerb side, a right turn lane on the median side (on a two-way street it sits in the median, which must be a lane wide). Cars planning that turn move into it once they reach it. Its arrow is clickable like the others. Adding or resizing one restarts the test traffic.">
                <div id="editor-turn-lanes" class="space-y-2"></div>
            </x-control-section>

            <x-control-section title="Lane arrows & saving" info="Click an arrow before a stop line on the map to change what that lane may do; right-click steps back. Only turns this junction actually allows are offered, and every approach keeps at least one lane going straight. Changes apply to the test traffic straight away; Save writes them, and any turn lanes, into your layout.">
                <p id="lane-edit-status" class="text-[11px] text-slate-600 dark:text-slate-300">Click an arrow to change it · right-click steps back</p>
                <div class="flex flex-wrap gap-1.5">
                    <button type="button" id="lane-edit-save" class="rounded-md border border-sky-600 bg-sky-600 px-2.5 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40">Save</button>
                    <button type="button" id="lane-edit-discard" title="Put back the arrows as last saved" class="{{ $buttonNeutral }}">Discard</button>
                    <button type="button" id="lane-edit-revert" title="Put this layout back as it was imported" class="rounded-md border border-rose-300 bg-white px-2.5 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-rose-500/40 dark:bg-slate-800 dark:text-rose-300 dark:hover:bg-rose-500/10">Revert to original</button>
                </div>
                <p class="text-[10px] text-slate-500">Saving writes this intersection's arrows and turn lanes into your layout. Revert to original puts the whole layout back as it was imported.</p>
            </x-control-section>

            <x-control-section title="Test traffic" info="Only for trying the arrows out here - none of these are saved.">
                <div>
                    <div class="mb-1 flex items-center justify-between text-xs">
                        <label for="editor-arterial-demand" class="font-medium text-slate-700 dark:text-slate-300">Main road</label>
                        <span id="editor-arterial-demand-value" class="font-mono text-[11px] text-slate-500"></span>
                    </div>
                    <input type="range" id="editor-arterial-demand" min="1" max="20" step="1" value="10" class="w-full accent-sky-600">
                </div>
                <div>
                    <div class="mb-1 flex items-center justify-between text-xs">
                        <label for="editor-cross-demand" class="font-medium text-slate-700 dark:text-slate-300">Cross street</label>
                        <span id="editor-cross-demand-value" class="font-mono text-[11px] text-slate-500"></span>
                    </div>
                    <input type="range" id="editor-cross-demand" min="0" max="15" step="1" value="6" class="w-full accent-sky-600">
                </div>
                <div>
                    <div class="mb-1 flex items-center justify-between text-xs">
                        <label for="editor-turn-share" class="font-medium text-slate-700 dark:text-slate-300">Cars turning</label>
                        <span id="editor-turn-share-value" class="font-mono text-[11px] text-slate-500"></span>
                    </div>
                    <input type="range" id="editor-turn-share" min="0" max="80" step="5" value="40" class="w-full accent-sky-600">
                </div>
            </x-control-section>
        </aside>

        {{-- ========================================================== CANVAS --}}
        <div class="flex min-w-0 flex-1 flex-col">
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/70">
                <div class="flex items-center gap-1.5">
                    <button type="button" id="editor-run-toggle" data-active="false"
                            class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition
                                   bg-emerald-600 text-white hover:bg-emerald-500
                                   dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400
                                   data-[active=true]:bg-amber-500 data-[active=true]:text-slate-950 data-[active=true]:hover:bg-amber-400">
                        <span data-when-inactive>▶ Play</span>
                        <span data-when-active class="hidden">❙❙ Pause</span>
                    </button>
                    <button type="button" id="editor-reset" class="{{ $buttonNeutral }}">Reset traffic</button>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Speed</span>
                    <div class="w-44">
                        <x-segmented control="editor-speed" size="sm" :value="1" :options="$speedOptions" />
                    </div>
                </div>
                <div class="ms-auto flex items-center gap-2 text-[11px] text-slate-500">
                    <button type="button" id="editor-overview" class="hidden {{ $buttonNeutral }}">← Whole corridor</button>
                    <span id="editor-node-title" class="font-medium text-slate-700 dark:text-slate-200"></span>
                    <span class="rounded-md border border-slate-200 bg-slate-100 px-2 py-1 font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300">t <span id="editor-clock">00:00.0</span></span>
                </div>
            </div>

            <div id="editor-canvas-wrap" class="relative min-h-[420px] flex-1 bg-slate-50 dark:bg-slate-950">
                <canvas id="editor-canvas" class="block h-full w-full cursor-grab active:cursor-grabbing"></canvas>

                <div class="pointer-events-auto absolute left-3 top-3 flex overflow-hidden rounded-md border border-slate-300 bg-white/90 backdrop-blur dark:border-slate-700 dark:bg-slate-900/90">
                    <button type="button" id="editor-zoom-out" title="Zoom out" class="px-2.5 py-1.5 text-xs text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">−</button>
                    <button type="button" id="editor-zoom-fit" title="Fit to view" class="border-x border-slate-300 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Fit</button>
                    <button type="button" id="editor-zoom-in" title="Zoom in" class="px-2.5 py-1.5 text-xs text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">+</button>
                </div>

                <div id="editor-hint" class="pointer-events-none absolute bottom-3 right-3 rounded-md border border-slate-200 bg-white/85 px-2.5 py-1.5 text-[10px] text-slate-500 backdrop-blur dark:border-slate-800 dark:bg-slate-900/85">
                    Click an intersection to edit it · drag to pan · scroll to zoom
                </div>

                <div id="editor-tooltip"
                     class="pointer-events-none absolute hidden max-w-[240px] rounded-md border border-slate-300 bg-white/95 px-3 py-2 text-[11px] shadow-xl backdrop-blur dark:border-slate-700 dark:bg-slate-900/95"></div>
            </div>
        </div>
    </div>

    <script type="application/json" id="road-editor-boot">@json($bootPayload)</script>

    @vite('resources/js/roadEditor.js')
</x-app-layout>
