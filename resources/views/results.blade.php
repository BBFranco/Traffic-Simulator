{{--
    /results - Phase 1 shell.

    Charts and tables are rendered against the hardcoded fake aggregates in
    ResultsController. The shapes match what the real `simulation_runs` queries
    return, so build step 22 swaps the data source and nothing else.
--}}
@php
    $modeLabels = ['fixed' => 'Fixed-time', 'adaptive' => 'Adaptive', 'green_wave' => 'Green wave'];
    $modeColours = ['fixed' => '#ea580c', 'adaptive' => '#8b5cf6', 'green_wave' => '#059669'];
    $powerLabels = ['normal' => 'Normal power', 'load_shedding' => 'Load shedding'];
    $sensorLabels = [
        'none' => 'None (timer only)',
        'inductive_loop' => 'Inductive loop',
        'radar' => 'Radar',
        'camera' => 'Camera',
        'magnetometer' => 'Magnetometer',
    ];

    // Data-table breakdown: fixed-time and green-wave collapse to one row apiece (see
    // ResultsController::aggregatesBySensor()'s docblock), adaptive gets one row per sensor mode.
    $sensorOrder = ['inductive_loop', 'radar', 'camera', 'magnetometer'];
    $byKeyBySensor = [];
    foreach ($aggregatesBySensor as $row) {
        $byKeyBySensor["{$row['controller_mode']}|{$row['power_state']}"][] = $row;
    }
    foreach ($byKeyBySensor as $key => $rows) {
        usort($rows, fn ($a, $b) => array_search($a['sensor_mode'], $sensorOrder, true) <=> array_search($b['sensor_mode'], $sensorOrder, true));
        $byKeyBySensor[$key] = $rows;
    }

    $card = 'rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60';
    $tableHead = 'bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 dark:bg-slate-950/40';
    $select = 'rounded-md border-slate-300 bg-white py-1.5 text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';

    // The "vs fixed-time" stat blocks: adaptive isn't one thing, it's whichever sensor is
    // reading the intersection, so each sensor (plus a blended average) is its own selectable
    // comparison target alongside green-wave - see ResultsController::pairedComparisons().
    // A comparison's delta can be null - a group made up entirely of pre-scope-migration
    // rows (see the scope-columns migration's docblock), or (for recovery) simply not
    // measured under normal power. Render a neutral placeholder rather than a fabricated number.
    $fmtDelta = fn (?float $v, string $suffix) => $v === null ? '—' : ($v > 0 ? '+' : '').number_format($v, 1).$suffix;

    $comparisonKey = fn (array $c) => $c['mode'].'|'.($c['sensor_mode'] ?? '');
    $comparisonLabel = function (array $c) use ($modeLabels, $sensorLabels) {
        if ($c['mode'] !== 'adaptive') {
            return $modeLabels[$c['mode']];
        }

        return $c['sensor_mode'] === 'average'
            ? 'Adaptive — avg. of sensors'
            : 'Adaptive — '.$sensorLabels[$c['sensor_mode']];
    };

    $comparisonOptions = [];
    foreach ($pairedComparisons as $c) {
        $key = $comparisonKey($c);
        if (isset($comparisonOptions[$key])) {
            continue;
        }
        $comparisonOptions[$key] = ['key' => $key, 'label' => $comparisonLabel($c), 'mode' => $c['mode'], 'sensor_mode' => $c['sensor_mode']];
    }
    usort($comparisonOptions, function ($a, $b) use ($sensorOrder) {
        $rank = function ($o) use ($sensorOrder) {
            if ($o['mode'] === 'adaptive' && $o['sensor_mode'] === 'average') {
                return -1;
            }

            return $o['mode'] === 'adaptive' ? array_search($o['sensor_mode'], $sensorOrder, true) : 100;
        };

        return $rank($a) <=> $rank($b);
    });
@endphp

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

    {{-- ONE filter row, scoping everything below it. --}}
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
            <label for="filter-sensor" class="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Sensor mode</label>
            <select id="filter-sensor" class="{{ $select }}">
                <option value="all" {{ request('sensor', 'all') === 'all' ? 'selected' : '' }}>All sensor modes</option>
                @foreach ($sensorLabels as $key => $label)
                    <option value="{{ $key }}" {{ request('sensor') === $key ? 'selected' : '' }}>{{ $label }}</option>
                @endforeach
            </select>
        </div>
        <p class="ms-auto max-w-xs text-[10px] leading-relaxed text-slate-500">
            Filters scope every chart, table, and the batch-run corridor on this page.
        </p>
    </div>

    {{-- Client-side only, same mechanism as "Compare against fixed-time" below - every chart
         already carries all three scopes' numbers, so switching this never refetches. --}}
    <div class="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/60">
        <div>
            <label for="filter-scope" class="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Scope</label>
            <select id="filter-scope" class="{{ $select }}">
                <option value="total" selected>Total (main + side streets)</option>
                <option value="arterial">Main arterial only</option>
                <option value="side_street">Side streets only</option>
            </select>
        </div>
        <p class="ms-auto max-w-xs text-[10px] leading-relaxed text-slate-500">
            Which roads' traffic every chart and stat block below measures.
        </p>
    </div>

    {{-- ============================================ the research question --}}
    <div class="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
            <h2 class="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Does ITS beat the fixed-time baseline?</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400">
                Paired comparison against Webster-timed fixed-time control on the same seeds, across every
                stat block below.
            </p>
        </div>
        <div>
            <label for="filter-its-target" class="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500">Compare against fixed-time</label>
            <select id="filter-its-target" class="{{ $select }}">
                @foreach ($comparisonOptions as $option)
                    <option value="{{ $option['key'] }}">{{ $option['label'] }}</option>
                @endforeach
            </select>
        </div>
    </div>

    <section class="mb-8">
        <div class="grid gap-3 sm:grid-cols-2">
            @foreach ($pairedComparisons as $comparison)
                @php
                    $improves = $comparison['wait_improves'];
                    $tone = match (true) {
                        $improves === null => 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/40',
                        $improves => 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/[0.06]',
                        default => 'border-rose-300 bg-rose-50/70 dark:border-rose-500/30 dark:bg-rose-500/[0.06]',
                    };
                    $figureTone = match (true) {
                        $improves === null => 'text-slate-400 dark:text-slate-500',
                        $improves => 'text-emerald-700 dark:text-emerald-300',
                        default => 'text-rose-700 dark:text-rose-300',
                    };
                @endphp
                <div class="rounded-lg border {{ $tone }} p-4" data-its-key="{{ $comparisonKey($comparison) }}" data-scope="{{ $comparison['scope'] }}">
                    <div class="flex items-center gap-2">
                        <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background-color: {{ $modeColours[$comparison['mode']] }}"></span>
                        <span class="text-xs font-semibold text-slate-900 dark:text-slate-100">{{ $comparisonLabel($comparison) }}</span>
                        <span class="text-[10px] text-slate-500">vs fixed-time</span>
                    </div>
                    <div class="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                        {{ $powerLabels[$comparison['power_state']] }}
                    </div>

                    <div class="mt-3 flex items-baseline gap-2">
                        <span class="text-3xl font-semibold leading-none {{ $figureTone }}">
                            {{ $fmtDelta($comparison['wait_delta_pct'], '%') }}
                        </span>
                        <span class="inline-flex items-center gap-1 text-[11px] font-medium {{ $figureTone }}">
                            @if ($improves === null)
                                not measured yet
                            @else
                                <span aria-hidden="true">{{ $improves ? '▼' : '▲' }}</span>
                                {{ $improves ? 'less waiting' : 'more waiting' }}
                            @endif
                        </span>
                    </div>
                    <p class="mt-0.5 text-[10px] text-slate-500">average wait per vehicle</p>

                    <dl class="mt-3 space-y-1 border-t border-slate-200 pt-2.5 text-[11px] dark:border-slate-800">
                        <div class="flex justify-between gap-2">
                            <dt class="text-slate-500">Throughput</dt>
                            <dd class="font-medium text-slate-800 dark:text-slate-200">
                                {{ $fmtDelta($comparison['throughput_delta_pct'], '%') }}
                            </dd>
                        </div>
                        <div class="flex justify-between gap-2">
                            <dt class="text-slate-500">Cleared w/o stopping</dt>
                            <dd class="font-medium text-slate-800 dark:text-slate-200">
                                {{ $fmtDelta($comparison['cleared_delta_pp'], ' pp') }}
                            </dd>
                        </div>
                    </dl>
                </div>
            @endforeach
        </div>
    </section>

    {{-- ============================================ more headline metrics --}}
    @php
        $metricSections = [
            [
                'heading' => 'Does ITS move more traffic?',
                'description' => 'Same paired comparison, headlining throughput instead of wait time. Higher is better.',
                'valueKey' => 'throughput_delta_pct',
                'improvesKey' => 'throughput_improves',
                'suffix' => '%',
                'improvedLabel' => 'more throughput',
                'worseLabel' => 'less throughput',
                'unitLabel' => 'vehicles cleared per minute',
                'secondary' => [
                    ['label' => 'Avg wait', 'key' => 'wait_delta_pct', 'suffix' => '%'],
                    ['label' => 'Cleared w/o stopping', 'key' => 'cleared_delta_pp', 'suffix' => ' pp'],
                ],
                'filter' => null,
            ],
            [
                'heading' => 'Does ITS clear more traffic without stopping?',
                'description' => 'Share of vehicles that pass through without a full stop. Higher is better.',
                'valueKey' => 'cleared_delta_pp',
                'improvesKey' => 'cleared_improves',
                'suffix' => ' pp',
                'improvedLabel' => 'more cleared w/o stopping',
                'worseLabel' => 'fewer cleared w/o stopping',
                'unitLabel' => 'percentage-point change',
                'secondary' => [
                    ['label' => 'Avg wait', 'key' => 'wait_delta_pct', 'suffix' => '%'],
                    ['label' => 'Throughput', 'key' => 'throughput_delta_pct', 'suffix' => '%'],
                ],
                'filter' => null,
            ],
            [
                'heading' => 'How fast does ITS recover from load shedding?',
                'description' => 'Time to return to normal flow once power is restored. Lower is better.',
                'valueKey' => 'recovery_delta_pct',
                'improvesKey' => 'recovery_improves',
                'suffix' => '%',
                'improvedLabel' => 'faster recovery',
                'worseLabel' => 'slower recovery',
                'unitLabel' => 'time to recovery',
                'secondary' => [
                    ['label' => 'Avg wait', 'key' => 'wait_delta_pct', 'suffix' => '%'],
                    ['label' => 'Throughput', 'key' => 'throughput_delta_pct', 'suffix' => '%'],
                ],
                'filter' => fn ($c) => $c['power_state'] === 'load_shedding' && $c['recovery_delta_pct'] !== null,
            ],
        ];
    @endphp

    @foreach ($metricSections as $section)
        @php
            $rows = array_values(array_filter($pairedComparisons, $section['filter'] ?? fn ($c) => true));
        @endphp
        @if (count($rows))
            <section class="mb-8">
                <h2 class="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{{ $section['heading'] }}</h2>
                <p class="mb-3 text-xs text-slate-500 dark:text-slate-400">{{ $section['description'] }}</p>

                <div class="grid gap-3 sm:grid-cols-2">
                    @foreach ($rows as $comparison)
                        @php
                            $improves = $comparison[$section['improvesKey']];
                            $value = $comparison[$section['valueKey']];
                            $tone = match (true) {
                                $improves === null => 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/40',
                                $improves => 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/[0.06]',
                                default => 'border-rose-300 bg-rose-50/70 dark:border-rose-500/30 dark:bg-rose-500/[0.06]',
                            };
                            $figureTone = match (true) {
                                $improves === null => 'text-slate-400 dark:text-slate-500',
                                $improves => 'text-emerald-700 dark:text-emerald-300',
                                default => 'text-rose-700 dark:text-rose-300',
                            };
                        @endphp
                        <div class="rounded-lg border {{ $tone }} p-4" data-its-key="{{ $comparisonKey($comparison) }}" data-scope="{{ $comparison['scope'] }}">
                            <div class="flex items-center gap-2">
                                <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background-color: {{ $modeColours[$comparison['mode']] }}"></span>
                                <span class="text-xs font-semibold text-slate-900 dark:text-slate-100">{{ $comparisonLabel($comparison) }}</span>
                                <span class="text-[10px] text-slate-500">vs fixed-time</span>
                            </div>
                            <div class="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                                {{ $powerLabels[$comparison['power_state']] }}
                            </div>

                            <div class="mt-3 flex items-baseline gap-2">
                                <span class="text-3xl font-semibold leading-none {{ $figureTone }}">
                                    {{ $fmtDelta($value, $section['suffix']) }}
                                </span>
                                <span class="inline-flex items-center gap-1 text-[11px] font-medium {{ $figureTone }}">
                                    @if ($improves === null)
                                        not measured yet
                                    @else
                                        <span aria-hidden="true">{{ $value >= 0 ? '▲' : '▼' }}</span>
                                        {{ $improves ? $section['improvedLabel'] : $section['worseLabel'] }}
                                    @endif
                                </span>
                            </div>
                            <p class="mt-0.5 text-[10px] text-slate-500">{{ $section['unitLabel'] }}</p>

                            <dl class="mt-3 space-y-1 border-t border-slate-200 pt-2.5 text-[11px] dark:border-slate-800">
                                @foreach ($section['secondary'] as $secondary)
                                    <div class="flex justify-between gap-2">
                                        <dt class="text-slate-500">{{ $secondary['label'] }}</dt>
                                        <dd class="font-medium text-slate-800 dark:text-slate-200">
                                            {{ $fmtDelta($comparison[$secondary['key']], $secondary['suffix']) }}
                                        </dd>
                                    </div>
                                @endforeach
                            </dl>
                        </div>
                    @endforeach
                </div>
            </section>
        @endif
    @endforeach

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
                <table class="w-full min-w-[720px] text-left text-xs">
                    <thead class="{{ $tableHead }}">
                        <tr>
                            <th scope="col" class="px-4 py-2 font-semibold">Controller mode</th>
                            <th scope="col" class="px-4 py-2 font-semibold">Power state</th>
                            <th scope="col" class="px-4 py-2 font-semibold">Sensor</th>
                            <th scope="col" class="px-4 py-2 text-right font-semibold">Runs</th>
                            <th scope="col" class="px-4 py-2 text-right font-semibold">Avg wait (s)</th>
                            <th scope="col" class="px-4 py-2 text-right font-semibold">Throughput (/min)</th>
                            <th scope="col" class="px-4 py-2 text-right font-semibold">Cleared w/o stop (%)</th>
                            <th scope="col" class="px-4 py-2 text-right font-semibold">Recovery (s)</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-200 tabular-nums dark:divide-slate-800">
                        @foreach ($powerStates as $power)
                            @foreach ($controllerModes as $mode)
                                @php $rows = $byKeyBySensor["{$mode}|{$power}"] ?? []; @endphp
                                @foreach ($rows as $row)
                                    <tr class="text-slate-700 dark:text-slate-300">
                                        <th scope="row" class="whitespace-nowrap px-4 py-2 font-medium text-slate-900 dark:text-slate-200">
                                            <span class="me-2 inline-block h-2 w-2 rounded-full align-middle" style="background-color: {{ $modeColours[$mode] }}"></span>
                                            {{ $modeLabels[$mode] }}
                                        </th>
                                        <td class="whitespace-nowrap px-4 py-2 text-slate-500 dark:text-slate-400">{{ $powerLabels[$power] }}</td>
                                        <td class="whitespace-nowrap px-4 py-2 text-slate-500 dark:text-slate-400">
                                            {{ $row['sensor_mode'] === null ? '—' : $sensorLabels[$row['sensor_mode']] }}
                                        </td>
                                        <td class="px-4 py-2 text-right">{{ $row['runs'] }}</td>
                                        <td class="px-4 py-2 text-right">{{ number_format($row['avg_wait_time'], 1) }}</td>
                                        <td class="px-4 py-2 text-right">{{ number_format($row['throughput_per_min'], 1) }}</td>
                                        <td class="px-4 py-2 text-right">{{ number_format($row['pct_cleared_without_stop'], 1) }}</td>
                                        <td class="px-4 py-2 text-right text-slate-500 dark:text-slate-400">
                                            {{ $row['time_to_recovery_seconds'] === null ? '—' : number_format($row['time_to_recovery_seconds'], 1) }}
                                        </td>
                                    </tr>
                                @endforeach
                            @endforeach
                        @endforeach
                    </tbody>
                </table>
            </div>
        </details>
    </section>

    {{-- ========================================================= recovery --}}
    <section class="mb-8 grid gap-4 xl:grid-cols-2">
        <figure class="min-w-0 {{ $card }} p-4">
            <figcaption class="mb-1">
                <span class="block text-[13px] font-semibold text-slate-900 dark:text-slate-100">Recovery after a power cut - throughput</span>
                <span class="text-[10px] text-slate-500">
                    vehicles cleared per minute · shaded band marks the outage window · adaptive follows the
                    "Compare against fixed-time" selection above
                </span>
            </figcaption>
            <div class="relative h-[280px] w-full">
                <canvas id="chart-recovery"></canvas>
            </div>
        </figure>

        <figure class="min-w-0 {{ $card }} p-4">
            <figcaption class="mb-1">
                <span class="block text-[13px] font-semibold text-slate-900 dark:text-slate-100">Recovery after a power cut - wait time</span>
                <span class="text-[10px] text-slate-500">
                    average wait, seconds per vehicle · shaded band marks the outage window · adaptive follows the
                    "Compare against fixed-time" selection above
                </span>
            </figcaption>
            <div class="relative h-[280px] w-full">
                <canvas id="chart-recovery-wait"></canvas>
            </div>
        </figure>

        <figure class="min-w-0 {{ $card }} p-4 xl:col-span-2">
            <figcaption class="mb-1">
                <span class="block text-[13px] font-semibold text-slate-900 dark:text-slate-100">Time to recovery</span>
                <span class="text-[10px] text-slate-500">seconds back to pre-cut wait · lower is better</span>
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
            One row per completed batch run. The seed plus the corridor config is enough to reproduce any
            row exactly.
        </p>

        <div class="overflow-x-auto {{ $card }}">
            <table class="w-full min-w-[860px] text-left text-xs">
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
                    @foreach ($recentRuns as $run)
                        <tr class="text-slate-700 dark:text-slate-300">
                            <td class="whitespace-nowrap px-4 py-2 font-mono text-slate-400 dark:text-slate-500">#{{ $run['id'] }}</td>
                            <td class="whitespace-nowrap px-4 py-2 font-mono text-slate-500 dark:text-slate-400">{{ $run['seed'] }}</td>
                            <td class="whitespace-nowrap px-4 py-2">
                                <span class="me-2 inline-block h-2 w-2 rounded-full align-middle" style="background-color: {{ $modeColours[$run['controller_mode']] }}"></span>
                                {{ $modeLabels[$run['controller_mode']] }}
                            </td>
                            <td class="whitespace-nowrap px-4 py-2">
                                @if ($run['power_state'] === 'load_shedding')
                                    <span class="rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300">Load shedding</span>
                                @else
                                    <span class="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">Normal</span>
                                @endif
                            </td>
                            <td class="whitespace-nowrap px-4 py-2 text-slate-500 dark:text-slate-400">
                                {{ $run['sensor_mode'] === null ? '—' : $sensorLabels[$run['sensor_mode']] }}
                            </td>
                            <td class="px-4 py-2 text-right">{{ number_format($run['avg_wait_time'], 1) }}</td>
                            <td class="px-4 py-2 text-right">{{ number_format($run['throughput_per_min'], 1) }}</td>
                            <td class="px-4 py-2 text-right">{{ number_format($run['pct_cleared_without_stop'], 1) }}</td>
                            <td class="px-4 py-2 text-right text-slate-500 dark:text-slate-400">
                                {{ $run['time_to_recovery_seconds'] === null ? '—' : number_format($run['time_to_recovery_seconds'], 1) }}
                            </td>
                        </tr>
                    @endforeach
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
