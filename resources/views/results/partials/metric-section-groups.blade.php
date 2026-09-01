{{--
    "More headline metrics" (throughput / cleared-without-stopping / recovery x2) - shared by
    results.blade.php's initial render and ResultsController::data()'s AJAX refresh. $metricSectionGroups
    is static config from ResultsController::metricSectionGroupsConfig(); $pairedComparisons is
    the real per-request data it's filtered against.
--}}
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
