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

    // Mode+power lookup for the segmented/distribution table below - Total scope only,
    // no sensor breakdown (keeps that table to one row per mode+power).
    $byModeAndPower = [];
    foreach ($aggregates as $row) {
        $byModeAndPower["{$row['controller_mode']}|{$row['power_state']}"] = $row;
    }

    // "24.1" -> "24.1 ± 1.2" when a 95% CI half-width is available (>= 2 reps).
    $fmtWithCi = fn (?float $value, ?float $ci95, int $decimals = 1) => $value === null
        ? '—'
        : number_format($value, $decimals).($ci95 === null ? '' : ' ± '.number_format($ci95, $decimals));

    // Scope suffix convention shared with ResultsController::SCOPES and results.js's
    // scopedMetric() - drives the per-condition-means and segmented tables below, which
    // render all three scopes' rows up front and let JS toggle which is visible (same
    // data-scope mechanism the "vs fixed-time" cards already use).
    $scopeSuffixes = ['total' => '', 'arterial' => '_arterial', 'side_street' => '_side_street'];

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

    // Recovery time on its own reads as "how good the controller is at recovering" - it isn't,
    // it only clocks how long throughput takes to sustain its way back to baseline, saying
    // nothing about where wait time actually settles afterwards. Always show it next to that
    // steady-state figure so a short-but-still-elevated recovery can't pass as fully healed.
    $fmtSecondsPair = fn (?float $subject, ?float $baseline, string $suffix = 's') => ($subject === null || $baseline === null)
        ? '—'
        : number_format($subject, 1).$suffix.' vs '.number_format($baseline, 1).$suffix;

    // Recovery time itself (unlike the post-recovery steady-state above) can go unmeasured on
    // either side: computeRecoverySeconds() returns null whenever a metric never sustains its
    // way back to baseline before the run ends - most commonly fixed-time's own wait-time
    // baseline, which this corridor's fixed-cycle signals don't fully clear within the
    // measured post-restore window (a real result, not a data gap - see the results-page
    // audit). Show each side on its own rather than collapsing the whole row to "-" the moment
    // either side is missing, so a subject that DID recover isn't hidden by a baseline that
    // didn't.
    $fmtRecoverySide = fn (?float $v, string $suffix = 's') => $v === null ? 'did not recover in window' : number_format($v, 1).$suffix;

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
                    <div class="mt-0.5 flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                        <span>{{ $powerLabels[$comparison['power_state']] }}</span>
                        <span class="font-mono normal-case tracking-normal text-slate-400">n={{ $comparison['runs'] }} vs {{ $comparison['baseline_runs'] }}</span>
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
        // Groups of sections rendered side by side (lg+) - a group of one is just a full-width
        // section, same as before. The recovery pair is two independently-computed clocks (see
        // runHeadless.js's computeRecoverySeconds()): one for wait time returning to baseline,
        // one for throughput - kept as siblings so neither reads as "the" recovery number.
        $metricSectionGroups = [
            [
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
            ],
            [
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
            ],
            [
                [
                    'heading' => 'How fast does ITS recover from load shedding? - wait time',
                    'description' => 'Time for wait time to drop back to its pre-cut level once power is restored. Lower is better.',
                    'valueKey' => 'recovery_wait_delta_pct',
                    'improvesKey' => 'recovery_wait_improves',
                    'suffix' => '%',
                    'improvedLabel' => 'faster recovery',
                    'worseLabel' => 'slower recovery',
                    'unitLabel' => 'time to recovery',
                    'secondary' => [
                        ['label' => 'Avg wait', 'key' => 'wait_delta_pct', 'suffix' => '%'],
                        ['label' => 'Throughput', 'key' => 'throughput_delta_pct', 'suffix' => '%'],
                    ],
                    // Deliberately NOT requiring recovery_wait_delta_pct !== null here: fixed-time's
                    // own wait-time baseline routinely never crosses the recovered threshold within
                    // the measured window on this corridor (a real result - see $fmtRecoverySide's
                    // comment above), which would otherwise silently hide every comparison against
                    // it. The card itself renders that as "did not recover in window" instead.
                    'filter' => fn ($c) => $c['power_state'] === 'load_shedding',
                    // Recovery time alone can't be trusted (see $fmtSecondsPair's comment above) -
                    // this card always renders it next to the post-recovery steady-state wait.
                    'recoveryPairMetric' => 'wait',
                ],
                [
                    'heading' => 'How fast does ITS recover from load shedding? - throughput',
                    'description' => 'Time for throughput to climb back to its pre-cut level once power is restored. Lower is better.',
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
                    // Same reasoning as the wait card's filter above - kept consistent even though
                    // throughput's own fixed-time baseline hasn't been observed to go unmeasured.
                    'filter' => fn ($c) => $c['power_state'] === 'load_shedding',
                    'recoveryPairMetric' => 'throughput',
                ],
            ],
        ];
    @endphp

    @foreach ($metricSectionGroups as $group)
        @php
            // Filter to the sections that actually have rows to show BEFORE deciding the
            // wrapper's column count - a sibling with no data yet (e.g. time_to_recovery_wait_
            // seconds on runs older than that column, see the memory note) must not still claim
            // a grid column, or the one section that does render gets squeezed to half-width.
            $renderableSections = array_values(array_filter(
                array_map(
                    fn ($section) => ['section' => $section, 'rows' => array_values(array_filter($pairedComparisons, $section['filter'] ?? fn ($c) => true))],
                    $group
                ),
                fn ($entry) => count($entry['rows'])
            ));
        @endphp
        @if (count($renderableSections))
            <div class="mb-8 grid gap-4 {{ count($renderableSections) > 1 ? 'lg:grid-cols-2' : '' }}">
                @foreach ($renderableSections as $entry)
                    @php
                        $section = $entry['section'];
                        $rows = $entry['rows'];
                    @endphp
                    <section>
                        <h2 class="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{{ $section['heading'] }}</h2>
                        <p class="mb-3 text-xs text-slate-500 dark:text-slate-400">{{ $section['description'] }}</p>

                        @php
                            // How many cards can be visible AT ONCE, not how many $rows carries:
                            // every sensor/scope combination is rendered into the DOM (JS toggles
                            // `.hidden` on the ones that don't match the current "Compare against
                            // fixed-time" + Scope selection - see applyItsTargetFilter()), but only
                            // one row per power_state is ever visible at a time. A recovery section
                            // only ever has load_shedding rows, so it's really a 1-visible-card grid
                            // even though $rows itself can hold a dozen hidden siblings - sizing the
                            // grid off count($rows) left it reserving a second, permanently-empty
                            // column.
                            $visiblePowerStates = count(array_unique(array_column($rows, 'power_state')));
                        @endphp
                        <div class="grid gap-3 {{ $visiblePowerStates > 1 ? 'sm:grid-cols-2' : '' }}">
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

                                    // For the recovery cards specifically, a null delta usually means one
                                    // side never crossed the recovered threshold within the measured
                                    // window (see $fmtRecoverySide's comment) rather than a data gap - say
                                    // so explicitly instead of the generic "not measured yet".
                                    $recoveryPairMetric = $section['recoveryPairMetric'] ?? null;
                                    $recoverySubjectSeconds = match ($recoveryPairMetric) {
                                        'wait' => $comparison['recovery_wait_seconds'],
                                        'throughput' => $comparison['recovery_seconds'],
                                        default => null,
                                    };
                                    $recoveryBaselineSeconds = match ($recoveryPairMetric) {
                                        'wait' => $comparison['baseline_recovery_wait_seconds'],
                                        'throughput' => $comparison['baseline_recovery_seconds'],
                                        default => null,
                                    };
                                @endphp
                                <div class="rounded-lg border {{ $tone }} p-4" data-its-key="{{ $comparisonKey($comparison) }}" data-scope="{{ $comparison['scope'] }}">
                                    <div class="flex items-center gap-2">
                                        <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background-color: {{ $modeColours[$comparison['mode']] }}"></span>
                                        <span class="text-xs font-semibold text-slate-900 dark:text-slate-100">{{ $comparisonLabel($comparison) }}</span>
                                        <span class="text-[10px] text-slate-500">vs fixed-time</span>
                                    </div>
                                    <div class="mt-0.5 flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                                        <span>{{ $powerLabels[$comparison['power_state']] }}</span>
                                        <span class="font-mono normal-case tracking-normal text-slate-400">n={{ $comparison['runs'] }} vs {{ $comparison['baseline_runs'] }}</span>
                                    </div>

                                    <div class="mt-3 flex items-baseline gap-2">
                                        <span class="text-3xl font-semibold leading-none {{ $figureTone }}">
                                            @if ($recoveryPairMetric)
                                                {{-- The headline here is the SELECTED mode's own recovery time, not
                                                     the delta vs fixed-time - fixed-time is supporting context (the
                                                     "Recovery time (subject vs fixed-time)" row below), not the main
                                                     attraction, and this stays meaningful even when fixed-time never
                                                     recovered in the window and no delta can be computed at all. --}}
                                                {{ $recoverySubjectSeconds === null ? '—' : number_format($recoverySubjectSeconds, 1).'s' }}
                                            @else
                                                {{ $fmtDelta($value, $section['suffix']) }}
                                            @endif
                                        </span>
                                        <span class="inline-flex items-center gap-1 text-[11px] font-medium {{ $figureTone }}">
                                            @if ($recoveryPairMetric)
                                                @if ($recoverySubjectSeconds === null && $recoveryBaselineSeconds === null)
                                                    neither side recovered in window
                                                @elseif ($recoverySubjectSeconds === null)
                                                    did not recover in window
                                                @elseif ($recoveryBaselineSeconds === null)
                                                    fixed-time did not recover in window
                                                @elseif ($improves === null)
                                                    not measured yet
                                                @else
                                                    <span aria-hidden="true">{{ $value >= 0 ? '▲' : '▼' }}</span>
                                                    {{ $fmtDelta($value, '%') }} {{ $improves ? $section['improvedLabel'] : $section['worseLabel'] }} than fixed-time
                                                @endif
                                            @elseif ($improves === null)
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
                                        @if (($section['recoveryPairMetric'] ?? null) === 'wait')
                                            <div class="flex justify-between gap-2">
                                                <dt class="text-slate-500">Recovery time (subject vs fixed-time)</dt>
                                                <dd class="font-medium text-slate-800 dark:text-slate-200">
                                                    {{ $fmtRecoverySide($recoverySubjectSeconds) }} vs {{ $fmtRecoverySide($recoveryBaselineSeconds) }}
                                                </dd>
                                            </div>
                                            <div class="flex justify-between gap-2">
                                                <dt class="text-slate-500">Post-recovery avg wait</dt>
                                                <dd class="font-medium text-slate-800 dark:text-slate-200">
                                                    {{ $fmtSecondsPair($comparison['post_recovery_avg_wait'], $comparison['baseline_post_recovery_avg_wait']) }}
                                                </dd>
                                            </div>
                                        @elseif (($section['recoveryPairMetric'] ?? null) === 'throughput')
                                            <div class="flex justify-between gap-2">
                                                <dt class="text-slate-500">Recovery time (subject vs fixed-time)</dt>
                                                <dd class="font-medium text-slate-800 dark:text-slate-200">
                                                    {{ $fmtRecoverySide($recoverySubjectSeconds) }} vs {{ $fmtRecoverySide($recoveryBaselineSeconds) }}
                                                </dd>
                                            </div>
                                            <div class="flex justify-between gap-2">
                                                <dt class="text-slate-500">Post-recovery throughput</dt>
                                                <dd class="font-medium text-slate-800 dark:text-slate-200">
                                                    {{ $fmtSecondsPair($comparison['post_recovery_throughput'], $comparison['baseline_post_recovery_throughput'], ' veh/min') }}
                                                </dd>
                                            </div>
                                        @endif
                                    </dl>
                                </div>
                            @endforeach
                        </div>
                    </section>
                @endforeach
            </div>
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
                        @foreach ($powerStates as $power)
                            @foreach ($controllerModes as $mode)
                                @php $rows = $byKeyBySensor["{$mode}|{$power}"] ?? []; @endphp
                                @foreach ($rows as $row)
                                    @foreach ($scopeSuffixes as $scope => $suffix)
                                        <tr class="text-slate-700 dark:text-slate-300 {{ $scope === 'total' ? '' : 'hidden' }}" data-scope="{{ $scope }}">
                                            <th scope="row" class="whitespace-nowrap px-4 py-2 font-medium text-slate-900 dark:text-slate-200">
                                                <span class="me-2 inline-block h-2 w-2 rounded-full align-middle" style="background-color: {{ $modeColours[$mode] }}"></span>
                                                {{ $modeLabels[$mode] }}
                                            </th>
                                            <td class="whitespace-nowrap px-4 py-2 text-slate-500 dark:text-slate-400">{{ $powerLabels[$power] }}</td>
                                            <td class="whitespace-nowrap px-4 py-2 text-slate-500 dark:text-slate-400">
                                                {{ $row['sensor_mode'] === null ? '—' : $sensorLabels[$row['sensor_mode']] }}
                                            </td>
                                            <td class="px-4 py-2 text-right">{{ $row['runs'] }}</td>
                                            <td class="px-4 py-2 text-right">{{ $fmtWithCi($row['avg_wait_time'.$suffix], $row['avg_wait_time'.$suffix.'_ci95']) }}</td>
                                            <td class="px-4 py-2 text-right">{{ $fmtWithCi($row['throughput_per_min'.$suffix], $row['throughput_per_min'.$suffix.'_ci95']) }}</td>
                                            <td class="px-4 py-2 text-right">{{ $fmtWithCi($row['pct_cleared_without_stop'.$suffix], $row['pct_cleared_without_stop'.$suffix.'_ci95']) }}</td>
                                            <td class="px-4 py-2 text-right text-slate-500 dark:text-slate-400">
                                                {{ $row['time_to_recovery_seconds'.$suffix] === null ? '—' : number_format($row['time_to_recovery_seconds'.$suffix], 1) }}
                                            </td>
                                        </tr>
                                    @endforeach
                                @endforeach
                            @endforeach
                        @endforeach
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
                    @foreach ($controllerModes as $mode)
                        @php $row = $byModeAndPower["{$mode}|load_shedding"] ?? null; @endphp
                        @if ($row)
                            @foreach ($scopeSuffixes as $scope => $suffix)
                                <tr class="text-slate-700 dark:text-slate-300 {{ $scope === 'total' ? '' : 'hidden' }}" data-scope="{{ $scope }}">
                                    <th scope="row" class="whitespace-nowrap px-4 py-2 font-medium text-slate-900 dark:text-slate-200">
                                        <span class="me-2 inline-block h-2 w-2 rounded-full align-middle" style="background-color: {{ $modeColours[$mode] }}"></span>
                                        {{ $modeLabels[$mode] }}
                                    </th>
                                    <td class="px-4 py-2 text-right">{{ $row['median_wait_time'] === null ? '—' : number_format($row['median_wait_time'], 1) }}</td>
                                    <td class="px-4 py-2 text-right">{{ $row['p95_wait_time'] === null ? '—' : number_format($row['p95_wait_time'], 1) }}</td>
                                    <td class="px-4 py-2 text-right">{{ $row['max_wait_time'] === null ? '—' : number_format($row['max_wait_time'], 1) }}</td>
                                    <td class="px-4 py-2 text-right">{{ $row['avg_wait_time_pre_outage'.$suffix] === null ? '—' : number_format($row['avg_wait_time_pre_outage'.$suffix], 1) }}</td>
                                    <td class="px-4 py-2 text-right text-slate-400">{{ $row['avg_wait_time_during_outage'.$suffix] === null ? '—' : number_format($row['avg_wait_time_during_outage'.$suffix], 1) }}</td>
                                    <td class="px-4 py-2 text-right">{{ $row['avg_wait_time_post_recovery'.$suffix] === null ? '—' : number_format($row['avg_wait_time_post_recovery'.$suffix], 1) }}</td>
                                    <td class="px-4 py-2 text-right">{{ $row['throughput_per_min_pre_outage'.$suffix] === null ? '—' : number_format($row['throughput_per_min_pre_outage'.$suffix], 1) }}</td>
                                    <td class="px-4 py-2 text-right text-slate-400">{{ $row['throughput_per_min_during_outage'.$suffix] === null ? '—' : number_format($row['throughput_per_min_during_outage'.$suffix], 1) }}</td>
                                    <td class="px-4 py-2 text-right">{{ $row['throughput_per_min_post_recovery'.$suffix] === null ? '—' : number_format($row['throughput_per_min_post_recovery'.$suffix], 1) }}</td>
                                </tr>
                            @endforeach
                        @endif
                    @endforeach
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
            are dimmed rather than hidden, so you can still audit recent activity generally. Use the
            "Sensor mode" filter at the top of the page to actually restrict this table.
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
                        <tr class="text-slate-700 transition dark:text-slate-300"
                            data-run-controller-mode="{{ $run['controller_mode'] }}"
                            data-run-sensor-mode="{{ $run['sensor_mode'] ?? '' }}">
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
