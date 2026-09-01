{{--
    /results - real Eloquent aggregates against `simulation_runs`, computed by
    ResultsController::buildPayload() and its viewModel()/metricSectionGroupsConfig()
    helpers. The display-only derivations (labels, colours, formatters, lookups) live in the
    controller rather than here so ResultsController::data()'s AJAX refresh can render the exact
    same partials this page uses, with fresh data, instead of drifting out of sync with a second
    copy of the same logic.
--}}

<x-app-layout title="Results" wide>
    <x-slot name="header">
        <div class="flex flex-wrap items-end justify-between gap-4">
            <div>
                <h1 class="text-xl font-semibold leading-tight text-slate-900 dark:text-slate-100">Results</h1>
                <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Aggregates across {{ number_format($totalRuns) }} batch runs · 30 seeded reps per condition
                </p>
            </div>
            <div class="flex flex-wrap items-center gap-3">
                <span id="fake-data-badge" class="inline-flex items-center gap-2 rounded-md border border-amber-400 bg-amber-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-800 {{ $isFakeData ? '' : 'hidden' }} dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                    <svg class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.63-1.516 2.63H3.72c-1.347 0-2.189-1.463-1.515-2.63L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd" /></svg>
                    No data yet
                </span>

                <span id="batch-running-badge" class="hidden inline-flex items-center gap-2 rounded-md border border-sky-400 bg-sky-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-300">
                    <svg class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path></svg>
                    Running
                </span>

                <button type="button" id="batch-run-button"
                        class="shrink-0 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400">
                    Generate dataset (360 runs)
                </button>
            </div>
        </div>
    </x-slot>

    <div id="fake-data-banner" class="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-[12px] leading-relaxed text-amber-900 {{ $isFakeData ? '' : 'hidden' }} dark:border-amber-500/25 dark:bg-amber-500/5 dark:text-amber-200/85">
        <strong class="font-semibold">Nothing below is measured yet.</strong>
        Click <strong>Generate dataset</strong> to run the full 12-condition x 30-rep experimental matrix
        (360 headless runs) in this browser tab and populate
        <code class="rounded bg-amber-100 px-1 dark:bg-amber-500/10">simulation_runs</code>. It stays responsive
        while it runs - the tab is not frozen, just busy.
    </div>

    <div id="batch-progress-wrap" class="hidden mb-6 rounded-lg border border-sky-300 bg-sky-50 p-4 dark:border-sky-500/25 dark:bg-sky-500/5">
        <div class="mb-2 flex items-baseline justify-between gap-3 text-[12px] text-sky-900 dark:text-sky-200">
            <span id="batch-progress-label" class="font-semibold">Starting...</span>
            <span id="batch-progress-pct" class="tabular-nums text-sky-700 dark:text-sky-300">0%</span>
        </div>
        <div class="h-2.5 w-full overflow-hidden rounded-full bg-sky-200/70 dark:bg-sky-900/60">
            <div id="batch-progress-bar" class="h-full w-0 rounded-full bg-sky-600 transition-[width] duration-150 dark:bg-sky-400"></div>
        </div>
    </div>

    {{-- Completion toast + fireworks burst, shown once the 360-run batch finishes. --}}
    <div id="batch-complete-toast" class="hidden fixed right-4 top-4 z-[60] flex items-center gap-2 rounded-md border border-emerald-400 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-800 shadow-lg dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300">
        <svg class="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clip-rule="evenodd" /></svg>
        <span id="batch-complete-toast-label">Dataset generated.</span>
    </div>
    <div id="fireworks-container" class="hidden pointer-events-none fixed inset-0 z-50"></div>

    {{-- ONE filter row, scoping everything below it. The Scope select is client-side only,
         same mechanism as "Compare against fixed-time" below - every chart already carries
         all three scopes' numbers, so switching it never refetches. --}}
    <div class="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/60">
        <div>
            <label for="filter-corridor" class="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Corridor</label>
            <select id="filter-corridor" class="{{ $select }}">
                <option value="" {{ request('corridor') ? '' : 'selected' }}>All corridors</option>
                @foreach ($corridors as $corridor)
                    <option value="{{ $corridor['id'] }}" {{ request('corridor') === $corridor['id'] ? 'selected' : '' }}>{{ $corridor['name'] }}</option>
                @endforeach
            </select>
        </div>
        <div>
            <label for="filter-its-target" class="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Compare against fixed-time</label>
            <select id="filter-its-target" class="{{ $select }}">
                @include('results.partials.its-target-options')
            </select>
        </div>
        <div>
            <label for="filter-scope" class="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Scope</label>
            <select id="filter-scope" class="{{ $select }}">
                <option value="total" selected>Total (main + side streets)</option>
                <option value="arterial">Main arterial only</option>
                <option value="side_street">Side streets only</option>
            </select>
        </div>
        <p class="ms-auto max-w-xs text-[10px] leading-relaxed text-slate-500">
            Corridor filters every chart, table, and the batch-run corridor; compare-against picks
            which ITS configuration the cards below are paired against fixed-time; scope picks
            which roads' traffic they measure.
        </p>
    </div>

    {{-- ============================================ the research question --}}
    <div class="mb-4">
        <h2 class="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Does ITS beat the fixed-time baseline?</h2>
        <p class="text-xs text-slate-500 dark:text-slate-400">
            Paired comparison against Webster-timed fixed-time control on the same seeds, across every
            stat block below.
        </p>
    </div>

    <section class="mb-8">
        <div class="grid gap-3 sm:grid-cols-2" id="research-question-cards">
            @include('results.partials.research-question-cards')
        </div>
    </section>

    {{-- ============================================ more headline metrics --}}
    <div id="metric-section-groups">
        @include('results.partials.metric-section-groups')
    </div>

    {{-- ========================================================= bar trio --}}
    <section class="mb-8">
        <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
                <h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Per-condition means</h2>
                <p class="text-xs text-slate-500 dark:text-slate-400">
                    Each controller mode under normal power and under load shedding. Adaptive's bars follow the
                    "Compare against fixed-time" selection above.
                </p>
            </div>
            {{-- Shared legend: identity is text + swatch, never colour alone. --}}
            <ul class="flex flex-wrap items-center gap-x-4 gap-y-1">
                @foreach ($controllerModes as $mode)
                    <li class="flex items-center gap-1.5 text-[11px] text-slate-700 dark:text-slate-300">
                        <span class="h-2.5 w-2.5 rounded-full" style="background-color: {{ $modeColours[$mode] }}"></span>
                        {{ $modeLabels[$mode] }}
                    </li>
                @endforeach
            </ul>
        </div>

        <div class="grid gap-4 xl:grid-cols-3">
            @foreach ([
                ['id' => 'chart-wait', 'title' => 'Average wait time', 'unit' => 'seconds per vehicle', 'better' => 'lower is better'],
                ['id' => 'chart-throughput', 'title' => 'Throughput', 'unit' => 'vehicles cleared per minute', 'better' => 'higher is better'],
                ['id' => 'chart-cleared', 'title' => 'Cleared without stopping', 'unit' => '% of vehicles', 'better' => 'higher is better'],
            ] as $chart)
                {{-- min-w-0 matters: without it the grid item takes its min-content
                     width from the canvas, the canvas sizes itself from the item, and
                     the chart overflows the card. --}}
                <figure class="min-w-0 {{ $card }} p-4">
                    <figcaption class="mb-1">
                        <span class="block text-[13px] font-semibold text-slate-900 dark:text-slate-100">{{ $chart['title'] }}</span>
                        <span class="text-[10px] text-slate-500">{{ $chart['unit'] }} · {{ $chart['better'] }}</span>
                    </figcaption>
                    <div class="relative h-[260px] w-full">
                        <canvas id="{{ $chart['id'] }}"></canvas>
                    </div>
                </figure>
            @endforeach
        </div>

        {{-- Table twin for the three charts above. --}}
        <details class="mt-3 {{ $card }}">
            <summary class="cursor-pointer px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
                Show data table
            </summary>
            <div class="overflow-x-auto border-t border-slate-200 dark:border-slate-800">
                <table id="per-condition-table" class="w-full min-w-[720px] text-left text-xs">
                    <thead class="{{ $tableHead }}">
                        <tr>
                            <th scope="col" class="px-4 py-2 font-semibold">Controller mode</th>
                            <th scope="col" class="px-4 py-2 font-semibold">Power state</th>
                            <th scope="col" class="px-4 py-2 font-semibold">Sensor</th>
                            <th scope="col" class="px-4 py-2 text-right font-semibold">Runs</th>
                            <th scope="col" class="px-4 py-2 text-right font-semibold">Avg wait (s, ± 95% CI)</th>
                            <th scope="col" class="px-4 py-2 text-right font-semibold">Throughput (/min, ± 95% CI)</th>
                            <th scope="col" class="px-4 py-2 text-right font-semibold">Cleared w/o stop (%, ± 95% CI)</th>
                            <th scope="col" class="px-4 py-2 text-right font-semibold">Recovery (s)</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-200 tabular-nums dark:divide-slate-800">
                        @include('results.partials.per-condition-rows')
                    </tbody>
                </table>
            </div>
        </details>
    </section>

    {{-- ============================================ segmented + distribution --}}
    <section class="mb-8">
        <h2 class="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Load shedding, segmented</h2>
        <p class="mb-3 text-xs text-slate-500 dark:text-slate-400">
            Pre-outage / during-outage / post-recovery averages, computed from cumulative
            counters rather than a rolling window - this is what shows the real Adaptive-vs-
            Fixed-time gap on either side of the outage, instead of a snapshot near the end of
            the run. During the outage every controller mode falls back to the same all-way-stop
            control, so near-identical numbers there are expected, not a sign adaptive handles
            outages well. The wait distribution columns (median/p95/max) are always Total scope
            regardless of the selector above - a single mean can't tell "everyone waits a bit
            longer" apart from "most people are fine, a few are stranded", but that distribution
            isn't split by arterial/side-street.
        </p>

        <div class="overflow-x-auto {{ $card }}" id="segmented-table">
            <table class="w-full min-w-[1080px] text-left text-xs">
                <thead class="{{ $tableHead }}">
                    <tr>
                        <th scope="col" class="px-4 py-2 font-semibold">Controller mode</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">Median wait (s, Total)</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">P95 wait (s, Total)</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">Max wait (s, Total)</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">Pre-outage wait (s)</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">During-outage wait (s)</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">Post-recovery wait (s)</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">Pre-outage thru (/min)</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">During-outage thru (/min)</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">Post-recovery thru (/min)</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-slate-200 tabular-nums dark:divide-slate-800">
                    @include('results.partials.segmented-rows')
                </tbody>
            </table>
        </div>
    </section>

    {{-- ========================================================= recovery --}}
    <section class="mb-8 grid gap-4 xl:grid-cols-2">
        <figure class="min-w-0 {{ $card }} p-4">
            <figcaption class="mb-1">
                <span class="block text-[13px] font-semibold text-slate-900 dark:text-slate-100">Recovery after a power cut - wait time</span>
                <span class="text-[10px] text-slate-500">
                    average wait, seconds per vehicle · shaded band marks the outage window (power is
                    restored at its right edge) · adaptive follows the "Compare against fixed-time"
                    selection above
                </span>
            </figcaption>
            <div class="relative h-[280px] w-full">
                <canvas id="chart-recovery-wait"></canvas>
            </div>
        </figure>

        <figure class="min-w-0 {{ $card }} p-4">
            <figcaption class="mb-1">
                <span class="block text-[13px] font-semibold text-slate-900 dark:text-slate-100">Recovery after a power cut - throughput</span>
                <span class="text-[10px] text-slate-500">
                    vehicles cleared per minute · shaded band marks the outage window (power is
                    restored at its right edge) · adaptive follows the "Compare against fixed-time"
                    selection above
                </span>
            </figcaption>
            <div class="relative h-[280px] w-full">
                <canvas id="chart-recovery"></canvas>
            </div>
        </figure>

        <figure class="min-w-0 {{ $card }} p-4">
            <figcaption class="mb-1">
                <span class="block text-[13px] font-semibold text-slate-900 dark:text-slate-100">Time to recovery - wait time</span>
                <span class="text-[10px] text-slate-500">seconds back to pre-cut wait · lower is better</span>
            </figcaption>
            <div class="relative h-[280px] w-full">
                <canvas id="chart-recovery-time-wait"></canvas>
            </div>
        </figure>

        <figure class="min-w-0 {{ $card }} p-4">
            <figcaption class="mb-1">
                <span class="block text-[13px] font-semibold text-slate-900 dark:text-slate-100">Time to recovery - throughput</span>
                <span class="text-[10px] text-slate-500">seconds back to pre-cut throughput · lower is better</span>
            </figcaption>
            <div class="relative h-[280px] w-full">
                <canvas id="chart-recovery-time"></canvas>
            </div>
        </figure>
    </section>

    {{-- ====================================================== recent runs --}}
    <section class="mb-10">
        <h2 class="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Recent runs</h2>
        <p class="mb-3 text-xs text-slate-500 dark:text-slate-400">
            One row per completed batch run, most recent first - not filtered by the "Compare against
            fixed-time" selection above, so it can easily show a different sensor mode than whatever
            aggregate you're looking at. Rows matching the current selection are highlighted; the rest
            are dimmed rather than hidden, so you can still audit recent activity generally.
        </p>

        <div class="overflow-x-auto {{ $card }}">
            <table id="recent-runs-table" class="w-full min-w-[860px] text-left text-xs">
                <thead class="{{ $tableHead }}">
                    <tr>
                        <th scope="col" class="px-4 py-2.5 font-semibold">Run</th>
                        <th scope="col" class="px-4 py-2.5 font-semibold">Seed</th>
                        <th scope="col" class="px-4 py-2.5 font-semibold">Controller</th>
                        <th scope="col" class="px-4 py-2.5 font-semibold">Power</th>
                        <th scope="col" class="px-4 py-2.5 font-semibold">Sensor</th>
                        <th scope="col" class="px-4 py-2.5 text-right font-semibold">Avg wait (s)</th>
                        <th scope="col" class="px-4 py-2.5 text-right font-semibold">Thru (/min)</th>
                        <th scope="col" class="px-4 py-2.5 text-right font-semibold">No-stop (%)</th>
                        <th scope="col" class="px-4 py-2.5 text-right font-semibold">Recovery (s)</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-slate-200 tabular-nums dark:divide-slate-800">
                    @include('results.partials.recent-runs-rows')
                </tbody>
            </table>
        </div>
    </section>

    @php
        $chartPayload = [
            'aggregates' => $aggregates,
            'aggregatesBySensor' => $aggregatesBySensor,
            'controllerModes' => $controllerModes,
            'powerStates' => $powerStates,
            'recoveryTimeline' => $recoveryTimeline,
            'corridorUrlTemplate' => route('corridors.show', ['corridor' => '__ID__']),
            'resultsDataUrl' => route('results.data'),
            'defaultCorridorId' => $corridors[0]['id'] ?? null,
        ];
    @endphp
    <script type="application/json" id="results-data">@json($chartPayload)</script>

    @vite('resources/js/results.js')
</x-app-layout>
