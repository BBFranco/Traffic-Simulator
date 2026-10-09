{{--
    /simulator - every control here drives the live simulation running in
    resources/js/simulator.js: corridor/seed/sensor/power/demand/vehicle
    controls, the run/step/speed transport, and the canvas + stats footer.
--}}
<x-app-layout title="Simulator" wide flush>
    <div class="flex flex-1 min-h-0 flex-col lg:flex-row">

        {{-- ============================================================ RAIL --}}
        <aside class="w-full lg:w-[336px] shrink-0 overflow-y-auto border-b border-slate-200 bg-slate-50 lg:border-b-0 lg:border-r dark:border-slate-800 dark:bg-slate-900">

            <x-control-section title="Scenario" info="Pick the road network and the random seed the run starts from.">
                <div>
                    <div class="mb-1 flex items-center gap-1.5">
                        <label for="corridor-select" class="text-xs font-medium text-slate-700 dark:text-slate-300">Corridor layout</label>
                        <x-info-tip id="corridor-description" />
                    </div>
                    <select id="corridor-select" class="{{ $select }}">
                        @foreach ($corridors as $corridor)
                            <option value="{{ $corridor['id'] }}" @selected($corridor['id'] === $defaultCorridorId)>
                                {{ $corridor['name'] }}
                            </option>
                        @endforeach
                    </select>
                    <dl id="corridor-facts" class="mt-2 grid grid-cols-3 gap-1 text-center"></dl>

                    {{-- A config the loader rejects has to say so here. Failing only
                         to the console reads as "the picker is broken". --}}
                    <div id="corridor-error"
                         class="mt-2 hidden rounded-md border border-rose-300 bg-rose-50 p-2.5 dark:border-rose-500/40 dark:bg-rose-500/10">
                        <p class="text-[11px] font-semibold text-rose-800 dark:text-rose-300">Corridor failed to load</p>
                        <p id="corridor-error-message" class="mt-1 font-mono text-[10px] leading-relaxed text-rose-700 dark:text-rose-200/90"></p>
                        <p class="mt-1.5 text-[10px] leading-relaxed text-rose-700/80 dark:text-rose-200/70">
                            The previously loaded corridor is still on the canvas.
                        </p>
                    </div>
                </div>

                <div>
                    <div class="mb-1 flex items-center gap-1.5">
                        <label for="seed-input" class="text-xs font-medium text-slate-700 dark:text-slate-300">Seed</label>
                        <x-info-tip text="The same seed and settings always produce exactly the same run." />
                    </div>
                    <div class="flex gap-2">
                        <input id="seed-input" type="number" min="0" step="1" value="20260818"
                               class="w-full rounded-md border-slate-300 bg-white py-1.5 font-mono text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
                        <button type="button" id="seed-randomise"
                                class="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
                            Random
                        </button>
                    </div>
                </div>
            </x-control-section>

            <x-control-section title="Replay a batch run" info="Plays back a run from the results dataset with its exact seed, controller, sensor and outage timing.">
                <div id="replay-empty-state" class="hidden text-[11px] leading-relaxed text-slate-500">
                    No batch runs found yet. Generate a dataset on the
                    <a href="{{ route('results') }}" class="font-medium text-sky-600 hover:underline dark:text-sky-400">Results page</a>
                    first.
                </div>
                <div id="replay-picker">
                    <div>
                        <label for="replay-family-select" class="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">Condition</label>
                        <select id="replay-family-select" class="{{ $select }}"></select>
                    </div>
                    <div class="mt-3">
                        <span class="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">Power</span>
                        <x-segmented control="replay-power-state" size="sm" value="normal"
                                     :options="['normal' => 'Normal', 'load_shedding' => 'Load shedding']" />
                    </div>
                    <button type="button" id="replay-load-button"
                            class="mt-3 w-full rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 transition hover:bg-sky-100 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-300 dark:hover:bg-sky-500/20">
                        Load &amp; play
                    </button>
                    <p id="replay-status" class="mt-1.5 text-[10px] leading-relaxed text-slate-500"></p>
                </div>
            </x-control-section>

            <x-control-section title="Signal control" info="Each arterial has its own controller. Its cross-streets follow the same mode, and the stats below compare the arterials live.">
                {{-- Populated from the loaded corridor: one row per arterial. --}}
                <div id="arterial-mode-controls" class="space-y-3"></div>
            </x-control-section>

            <x-control-section title="Sensing" info="What the signal controller can detect. Hover an option for details.">
                <div class="space-y-1.5" id="sensor-mode-group">
                    @foreach ($sensorModes as $key => $mode)
                        <label data-tip="{{ $mode['sees'] }}" class="group flex cursor-pointer items-center gap-2.5 {{ $inset }} px-2.5 py-2 transition hover:border-slate-300 has-[:checked]:border-sky-500/60 has-[:checked]:bg-sky-50 dark:hover:border-slate-700 dark:has-[:checked]:bg-sky-500/5">
                            <input type="radio" name="sensorMode" value="{{ $key }}" @checked($key === 'inductive_loop')
                                   class="{{ $radio }}">
                            <span class="min-w-0 flex-1">
                                <span class="flex items-center justify-between gap-2">
                                    <span class="text-xs font-medium text-slate-800 dark:text-slate-200">{{ $mode['label'] }}</span>
                                    <span class="shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide {{ $toneClasses[$mode['tone']] }}">
                                        {{ $mode['power'] }}
                                    </span>
                                </span>
                            </span>
                        </label>
                    @endforeach
                </div>
            </x-control-section>

            <x-control-section title="Power" info="During a power cut the lights go dark and intersections become all-way stops. Traffic keeps moving.">
                <button type="button" id="load-shedding-toggle" data-active="false"
                        class="w-full rounded-md border px-3 py-2.5 text-xs font-semibold uppercase tracking-wider transition
                               border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100
                               dark:border-amber-500/50 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20
                               data-[active=true]:border-rose-600 data-[active=true]:bg-rose-600 data-[active=true]:text-white data-[active=true]:hover:bg-rose-500
                               dark:data-[active=true]:border-rose-500">
                    <span data-when-inactive>Trigger load shedding</span>
                    <span data-when-active class="hidden">Restore power</span>
                </button>

                <label class="flex cursor-pointer items-start gap-2.5 {{ $inset }} p-2.5">
                    <input type="checkbox" id="scheduled-outages" class="mt-0.5 {{ $checkbox }}">
                    <span class="min-w-0 flex-1">
                        <span class="flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-200">
                            Scheduled rotating outages
                            <x-info-tip text="Eskom-style load shedding: the power goes off on a repeating schedule." />
                        </span>
                        <span class="mt-2 flex items-center gap-1.5 text-[10px] text-slate-600 dark:text-slate-400">
                            <input type="number" id="outage-off-minutes" value="2" min="1" max="60" class="w-14 {{ $tinyInput }}">
                            min dark, every
                            <input type="number" id="outage-period-minutes" value="8" min="2" max="180" class="w-14 {{ $tinyInput }}">
                            min
                        </span>
                    </span>
                </label>

                <label class="flex cursor-pointer items-start gap-2.5 {{ $inset }} p-2.5">
                    <input type="checkbox" id="battery-backed-sensors" checked class="mt-0.5 {{ $checkbox }}">
                    <span class="min-w-0 flex-1">
                        <span class="flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-200">
                            Battery-backed sensors
                            <x-info-tip text="Loops and magnetometers keep working during a cut. Cameras and radar always drop out." />
                        </span>
                    </span>
                </label>
            </x-control-section>

            <x-control-section title="Demand" info="How many vehicles enter each road per lane per minute. Demand swings between min and max over time.">
                <div id="demand-controls" class="space-y-3"></div>
            </x-control-section>

            <x-control-section title="Vehicles">
                <div>
                    <div class="mb-1 flex items-baseline justify-between gap-2">
                        <span class="flex items-center gap-1.5">
                            <label for="truck-ratio-input" class="text-xs font-medium text-slate-700 dark:text-slate-300">Truck mix</label>
                            <x-info-tip text="Share of new vehicles that are trucks, split across three sizes. Trucks are slower, so cars change lanes around them." />
                        </span>
                        <span class="font-mono text-[11px] text-slate-600 dark:text-slate-400"><span id="truck-ratio-value">0</span>%</span>
                    </div>
                    <input type="range" id="truck-ratio-input" min="0" max="50" step="1" value="0"
                           class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-300 accent-sky-600 dark:bg-slate-700 dark:accent-sky-500">
                </div>

                <div>
                    <div class="mb-1 flex items-baseline justify-between gap-2">
                        <span class="flex items-center gap-1.5">
                            <label for="bus-ratio-input" class="text-xs font-medium text-slate-700 dark:text-slate-300">Bus mix</label>
                            <x-info-tip text="Share of new vehicles that are 12 m city buses. Like trucks, they are slower and change lanes less, and they are never used in batch runs or replays." />
                        </span>
                        <span class="font-mono text-[11px] text-slate-600 dark:text-slate-400"><span id="bus-ratio-value">0</span>%</span>
                    </div>
                    <input type="range" id="bus-ratio-input" min="0" max="30" step="1" value="0"
                           class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-300 accent-sky-600 dark:bg-slate-700 dark:accent-sky-500">
                </div>

                <label class="flex cursor-pointer items-start gap-2.5 {{ $inset }} p-2.5">
                    <input type="checkbox" id="random-events" class="mt-0.5 {{ $checkbox }}">
                    <span class="min-w-0 flex-1">
                        <span class="flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-200">
                            Random events
                            <x-info-tip text="Just for fun, never used in batch runs or replays. Adds a rare purple BMW that drives 20 km/h over the limit and keeps weaving between lanes, Ford Ranger double cabs that sit in the fastest lane tailgating, and makes the minibus taxis keep to the left lane and stop to pick up passengers, holding up traffic behind them." />
                        </span>
                    </span>
                </label>

                <label class="flex cursor-pointer items-start gap-2.5 {{ $inset }} p-2.5 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
                    <input type="checkbox" id="destination-routing" class="mt-0.5 {{ $checkbox }}">
                    <span class="min-w-0 flex-1">
                        <span class="flex items-center gap-1.5 text-xs font-medium text-slate-800 dark:text-slate-200">
                            Destination routing
                            <x-info-tip text="Every car gets a destination when it spawns - a driveway on a block, or a way out of the map - and follows a route there instead of turning at random. Cars heading for a driveway keep to the lane beside it, slow down and turn in, waiting for a gap when they have to cross oncoming traffic. Only available on a corridor with a routing section; switching it restarts the run." />
                        </span>
                    </span>
                </label>
            </x-control-section>

            <div class="space-y-3 px-4 py-4">
                <details class="{{ $inset }}">
                    <summary class="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
                        Control state log
                    </summary>
                    <ol id="control-log" class="max-h-40 space-y-1 overflow-y-auto border-t border-slate-200 px-3 py-2 font-mono text-[10px] text-slate-600 dark:border-slate-800 dark:text-slate-400"></ol>
                </details>
            </div>
        </aside>

        {{-- ========================================================== CANVAS --}}
        <div class="flex min-w-0 flex-1 flex-col">

            {{-- Transport bar + canvas + stats footer. This wrapper is the element that
                 goes browser full screen, so the controls, the map and the live stats fill
                 the screen together; simulator.js mirrors document.fullscreenElement into
                 data-fullscreen. --}}
            <div id="sim-stage" data-fullscreen="false" class="group/stage flex min-h-0 flex-1 flex-col bg-slate-50 dark:bg-slate-950">

            {{-- Transport bar --}}
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/70">
                <div class="flex items-center gap-1.5">
                    <button type="button" id="run-toggle" data-active="false"
                            class="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition
                                   bg-emerald-600 text-white hover:bg-emerald-500
                                   dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400
                                   data-[active=true]:bg-amber-500 data-[active=true]:text-slate-950 data-[active=true]:hover:bg-amber-400">
                        <span data-when-inactive>▶ Run</span>
                        <span data-when-active class="hidden">❙❙ Pause</span>
                    </button>
                    <button type="button" id="step-button"
                            class="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
                        Step
                    </button>
                    <button type="button" id="run-to-time-button" title="Run at maximum catch-up speed until the sim clock reaches t=1000s, then pause"
                            class="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
                        Run to t=1000s
                    </button>
                    <button type="button" id="reset-button"
                            class="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
                        Reset
                    </button>
                </div>

                <div class="flex items-center gap-2">
                    <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Speed</span>
                    <div class="w-64">
                        <x-segmented control="speed" size="sm" value="1" :options="$speedOptions" />
                    </div>
                </div>

                <div class="flex items-center gap-2">
                    <span class="text-[10px] font-semibold uppercase tracking-wider text-slate-500">View</span>
                    <div class="w-24">
                        <x-segmented control="view" size="sm" value="2d" :options="$viewOptions" />
                    </div>
                </div>

                <div class="ms-auto flex flex-wrap items-center gap-2">
                    <span class="{{ $pillBase }} border-slate-200 bg-slate-100 font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300">
                        <span class="text-slate-500">t</span>
                        <span id="sim-clock">00:00.0</span>
                    </span>
                    <span id="run-state-pill" class="{{ $pillNeutral }}">
                        <span class="h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500"></span>
                        <span id="run-state-label">Idle</span>
                    </span>
                    <span id="power-pill" class="{{ $pillBase }} border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300">
                        <span class="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400"></span>
                        <span id="power-label">Power normal</span>
                    </span>
                    <span class="{{ $pillBase }} border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300">
                        <span class="text-slate-500">Sensing</span>
                        <span id="sensor-pill-label">Inductive loop</span>
                    </span>
                </div>
            </div>

            {{-- Canvas --}}
            <div id="canvas-wrap" class="relative min-h-[340px] flex-1 bg-slate-50 dark:bg-slate-950">
                <canvas id="sim-canvas" class="block h-full w-full cursor-grab active:cursor-grabbing"></canvas>

                {{-- View controls --}}
                <div class="pointer-events-none absolute left-3 top-3 flex flex-col gap-2">
                    <div class="pointer-events-auto flex overflow-hidden rounded-md border border-slate-300 bg-white/90 backdrop-blur dark:border-slate-700 dark:bg-slate-900/90">
                        <button type="button" id="zoom-out" data-view-only="2d" title="Zoom out" class="px-2.5 py-1.5 text-xs text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">−</button>
                        <button type="button" id="zoom-fit" title="Fit network" class="border-x border-slate-300 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Fit</button>
                        <button type="button" id="zoom-in" data-view-only="2d" title="Zoom in" class="px-2.5 py-1.5 text-xs text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">+</button>
                    </div>
                    <div data-view-only="2d" class="pointer-events-auto rounded-md border border-slate-300 bg-white/90 p-2 backdrop-blur dark:border-slate-700 dark:bg-slate-900/90">
                        <span class="mb-1.5 block text-[9px] font-semibold uppercase tracking-wider text-slate-500">Layers</span>
                        <div class="space-y-1">
                            @foreach ([
                                'showLabels' => 'Names',
                                'showLaneMarkings' => 'Lane markings',
                                'showDistances' => 'Block distances',
                                'showSignalHeads' => 'Signal heads',
                                'showRouting' => 'Routes & driveways',
                            ] as $key => $label)
                                <label class="flex cursor-pointer items-center gap-1.5 text-[10px] text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200">
                                    <input type="checkbox" data-layer="{{ $key }}" checked
                                           class="h-3 w-3 rounded border-slate-300 bg-white text-sky-600 focus:ring-sky-500 focus:ring-offset-0 dark:border-slate-600 dark:bg-slate-800 dark:text-sky-500">
                                    {{ $label }}
                                </label>
                            @endforeach
                            @foreach ($mapOverlays as $key => $overlay)
                                <label class="flex cursor-pointer items-center gap-1.5 text-[10px] text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200">
                                    <input type="checkbox" data-layer="{{ $key }}"
                                           class="h-3 w-3 rounded border-slate-300 bg-white text-sky-600 focus:ring-sky-500 focus:ring-offset-0 dark:border-slate-600 dark:bg-slate-800 dark:text-sky-500">
                                    {{ $overlay['label'] }}
                                </label>
                                <div class="ms-[18px] flex items-center gap-1 text-[9px] text-slate-500">
                                    <span class="h-1.5 w-8 rounded-sm bg-gradient-to-r {{ $overlay['ramp'] }}"></span>
                                    {{ $overlay['legend'] }}
                                </div>
                            @endforeach
                        </div>
                    </div>
                </div>

                <div class="absolute right-3 top-3">
                    <button type="button" id="fullscreen-enter" title="Full screen"
                            class="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white/90 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 backdrop-blur transition hover:bg-slate-100 group-data-[fullscreen=true]/stage:hidden dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-300 dark:hover:bg-slate-800">
                        <span aria-hidden="true">⛶</span> Full screen
                    </button>
                    <button type="button" id="fullscreen-exit" title="Exit full screen (Esc)"
                            class="hidden items-center gap-1.5 rounded-md border border-slate-300 bg-white/90 px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 shadow-sm backdrop-blur transition hover:bg-slate-100 group-data-[fullscreen=true]/stage:inline-flex dark:border-slate-700 dark:bg-slate-900/90 dark:text-slate-200 dark:hover:bg-slate-800">
                        <span aria-hidden="true">✕</span> Exit full screen
                    </button>
                </div>

                <div class="pointer-events-none absolute bottom-3 right-3 rounded-md border border-slate-200 bg-white/85 px-2.5 py-1.5 text-[10px] text-slate-500 backdrop-blur dark:border-slate-800 dark:bg-slate-900/85">
                    <span data-view-only="2d">Drag to pan · scroll to zoom · click a car to follow it · double-click an intersection to centre it</span>
                    <span data-view-only="3d" class="hidden">Drag to orbit · right-drag to pan · scroll to zoom · click a car to follow it</span>
                </div>

                {{-- 3D view outage indicator (the 2D map shows the same state via the power pill) --}}
                <div id="outage-overlay"
                     class="pointer-events-none absolute left-1/2 top-3 hidden -translate-x-1/2 {{ $pillBase }} border-rose-300 bg-rose-50/95 text-rose-700 shadow-sm dark:border-rose-500/40 dark:bg-rose-950/80 dark:text-rose-300">
                    <span class="h-1.5 w-1.5 rounded-full bg-rose-500 dark:bg-rose-400"></span>
                    All-way stop · power out
                </div>

                {{-- The car clicked on the map: followed by the camera, its live stats here (simulator.js's selectCar()). --}}
                <div id="car-card"
                     class="absolute right-3 top-14 z-10 hidden w-[260px] space-y-0.5 rounded-md border border-slate-300 bg-white/95 px-3 py-2 text-[11px] shadow-xl backdrop-blur dark:border-slate-700 dark:bg-slate-900/95"></div>

                {{-- Hover readout --}}
                <div id="node-tooltip"
                     class="pointer-events-none absolute hidden w-[280px] rounded-md border border-slate-300 bg-white/95 px-3 py-2 text-[11px] shadow-xl backdrop-blur dark:border-slate-700 dark:bg-slate-900/95"></div>
            </div>

            {{-- ======================================================= FOOTER --}}
            {{-- Live statistics: a slim KPI bar, expandable into the full panel. It sits in the
                 #sim-stage column under #canvas-wrap, so expanding it shrinks the map (whose
                 ResizeObserver redraws it) rather than covering it. Every value is filled by
                 simulator.js from metrics/liveMetrics.js, once a simulated second. --}}
            <footer id="live-stats" data-expanded="false" class="group/live flex min-h-0 flex-col border-t lg:max-h-[60%] group-data-[fullscreen=true]/stage:max-h-[60%] border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                <div class="flex shrink-0 items-center gap-2 px-3 py-2">
                    <div class="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
                    @foreach ($liveKpis as $key => $kpi)
                        <div data-kpi="{{ $key }}"
                             class="{{ $loop->index >= 4 ? 'hidden sm:flex' : 'flex' }} min-w-[124px] shrink-0 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-950/50">
                            <div class="min-w-0">
                                <div class="text-[9px] font-semibold uppercase tracking-wider text-slate-500">{{ $kpi['label'] }}</div>
                                <div class="flex items-baseline gap-1">
                                    <span data-kpi-value class="font-mono text-sm tabular-nums leading-tight text-slate-900 dark:text-slate-100">—</span>
                                    <span class="text-[9px] text-slate-500">{{ $kpi['unit'] }}</span>
                                </div>
                            </div>
                            <canvas data-spark class="ms-auto h-[22px] w-[44px]" aria-hidden="true"></canvas>
                        </div>
                    @endforeach

                    <div class="flex shrink-0 items-center gap-1.5">
                        <span id="live-chip-power" class="{{ $pillNeutral }}">
                            <span class="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400" data-chip-dot></span>
                            <span data-chip-text class="tabular-nums">Power on</span>
                        </span>
                        <span id="live-chip-drift" class="{{ $pillNeutral }}" title="Trend of the rolling avg wait over the last 10 min, tested like the warm-up probe">
                            <span class="h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500" data-chip-dot></span>
                            <span data-chip-text>Settling</span>
                        </span>
                        <span id="live-chip-spillback" class="{{ $pillNeutral }}" title="Approaches whose queue reaches back into the junction upstream">
                            <span class="h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500" data-chip-dot></span>
                            <span data-chip-text class="tabular-nums">0 spillbacks</span>
                        </span>
                    </div>
                    </div>

                    <button type="button" id="live-stats-toggle" aria-expanded="false" aria-controls="live-stats-details" title="Show or hide the full statistics (S)"
                            class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
                        <span class="group-data-[expanded=true]/live:hidden">Details</span>
                        <span class="hidden group-data-[expanded=true]/live:inline">Hide</span>
                        <span aria-hidden="true" class="transition group-data-[expanded=true]/live:rotate-180">▴</span>
                    </button>
                </div>

                <div id="live-stats-details" class="hidden min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-slate-200 group-data-[expanded=true]/live:block dark:border-slate-800">
                    <div class="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2 xl:grid-flow-col xl:auto-cols-fr xl:grid-cols-none dark:bg-slate-800">
                        @foreach ($livePanels as $panelKey => $panel)
                            <section data-live-panel="{{ $panelKey }}" @class(['bg-white px-4 py-3 dark:bg-slate-900', 'hidden' => $panel['routingOnly']])>
                                <h3 class="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">{{ $panel['title'] }}</h3>
                                <dl class="mt-2 space-y-1">
                                    @foreach ($panel['rows'] as $rowKey => $rowLabel)
                                        <div data-live-row="{{ $rowKey }}" class="flex items-baseline justify-between gap-3 text-[11px]">
                                            <dt class="min-w-0 text-slate-500">{{ $rowLabel }}</dt>
                                            <dd data-live="{{ $rowKey }}" class="min-w-0 break-words text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">—</dd>
                                        </div>
                                    @endforeach
                                </dl>
                            </section>
                        @endforeach
                    </div>

                    <div class="flex flex-col border-t border-slate-200 lg:flex-row dark:border-slate-800">
                        <div class="min-w-0 flex-1 overflow-x-auto px-4 py-3">
                            <table class="w-full text-[11px]">
                                <thead>
                                    <tr class="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                                        @foreach ($liveRoadColumns as $columnKey => $columnLabel)
                                            <th scope="col" @class(['py-1 font-medium', 'text-left' => $loop->first, 'text-right' => ! $loop->first])>
                                                <button type="button" data-sort="{{ $columnKey }}" class="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-slate-200">
                                                    {{ $columnLabel }}<span data-sort-mark aria-hidden="true"></span>
                                                </button>
                                            </th>
                                        @endforeach
                                    </tr>
                                </thead>
                                <tbody id="live-road-rows"></tbody>
                            </table>
                        </div>

                        <div class="w-full shrink-0 border-slate-200 px-4 py-3 lg:w-[340px] lg:border-l dark:border-slate-800">
                            <div class="flex items-baseline justify-between">
                                <span class="text-[11px] font-semibold text-slate-700 dark:text-slate-300">Throughput over time</span>
                                <span class="text-[10px] text-slate-500">veh/min, 60 s rolling</span>
                            </div>
                            <div class="relative mt-2 h-[160px]">
                                <canvas id="stats-chart"></canvas>
                                <div id="stats-chart-empty"
                                     class="absolute inset-0 flex items-center justify-center rounded bg-slate-50/60 text-[10px] text-slate-500 dark:bg-slate-950/40">
                                    Awaiting simulation data
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </footer>
            </div>
        </div>
    </div>

    {{-- ============================================ runtime clone templates --}}

    {{-- Rendered by the Blade component so the JS-cloned mode selectors carry
         exactly the same classes (and therefore the same theming) as the ones
         written directly into the page above. --}}
    <template id="segmented-template">
        <x-segmented control="__CONTROL__" size="sm" :options="$controllerModeOptions" />
    </template>

    <template id="cleared-chip-template">
        <span class="inline-flex items-center gap-1.5 rounded border border-slate-200 bg-slate-50 px-1.5 py-1 dark:border-slate-800 dark:bg-slate-950/60">
            <span class="text-[9px] uppercase tracking-wide text-slate-500" data-chip-label></span>
            <span class="font-mono text-[11px] text-slate-800 dark:text-slate-200" data-chip-value>—</span>
        </span>
    </template>

    <template id="arterial-mode-template">
        <div class="{{ $inset }} p-3" data-arterial-mode-row>
            <div class="mb-2 flex items-center gap-2">
                <span class="h-2.5 w-2.5 shrink-0 rounded-full" data-accent-dot></span>
                <span class="truncate text-xs font-medium text-slate-800 dark:text-slate-200" data-arterial-name></span>
                <span class="ms-auto shrink-0 font-mono text-[10px] text-slate-500" data-arterial-meta></span>
            </div>
            <div data-segmented-slot></div>
        </div>
    </template>

    <template id="demand-row-template">
        <div data-demand-row>
            <div class="mb-1 flex items-baseline justify-between gap-2">
                <span class="truncate text-xs text-slate-700 dark:text-slate-300" data-demand-name></span>
                <span class="shrink-0 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                    <span data-demand-value></span> <span class="text-slate-400 dark:text-slate-600">veh/lane/min</span>
                </span>
            </div>
            <input type="range" min="0" max="30" step="1"
                   class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-300 accent-sky-600 dark:bg-slate-700 dark:accent-sky-500"
                   data-demand-input>
        </div>
    </template>

    {{-- Same panel, for an arterial/connector whose corridor config gives it a fluctuation range instead of one flat number (see corridor.js's buildDemand()) - two handles plus a live "now" readout of where the sinusoid actually is. --}}
    <template id="demand-row-fluctuating-template">
        <div data-demand-row class="space-y-1.5">
            <div class="mb-1 flex items-baseline justify-between gap-2">
                <span class="truncate text-xs text-slate-700 dark:text-slate-300" data-demand-name></span>
                <span class="shrink-0 font-mono text-[11px] text-slate-600 dark:text-slate-400">
                    now <span data-demand-now>—</span> <span class="text-slate-400 dark:text-slate-600">veh/lane/min</span>
                </span>
            </div>
            <div class="flex items-center gap-2">
                <span class="w-7 shrink-0 text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-600">min</span>
                <input type="range" min="0" max="30" step="1"
                       class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-300 accent-sky-600 dark:bg-slate-700 dark:accent-sky-500"
                       data-demand-min-input>
                <span class="w-6 shrink-0 text-right font-mono text-[11px] text-slate-600 dark:text-slate-400" data-demand-min-value></span>
            </div>
            <div class="flex items-center gap-2">
                <span class="w-7 shrink-0 text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-600">max</span>
                <input type="range" min="0" max="30" step="1"
                       class="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-300 accent-sky-600 dark:bg-slate-700 dark:accent-sky-500"
                       data-demand-max-input>
                <span class="w-6 shrink-0 text-right font-mono text-[11px] text-slate-600 dark:text-slate-400" data-demand-max-value></span>
            </div>
        </div>
    </template>

    <script type="application/json" id="sim-boot">@json($bootPayload)</script>

    @vite('resources/js/simulator.js')
</x-app-layout>
