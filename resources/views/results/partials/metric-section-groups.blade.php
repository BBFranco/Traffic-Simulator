{{--
    "More headline metrics" (throughput / cleared-without-stopping / recovery x2) - shared by
    results.blade.php's initial render and ResultsController::data()'s AJAX refresh.
    $renderableMetricSectionGroups is built by ResultsController::metricSectionRenderGroups() -
    section filtering, column counts, and per-card tone/value/recovery derivations all happen
    there so this partial stays presentation-only.
--}}
@foreach ($renderableMetricSectionGroups as $group)
    <div class="mb-8 grid gap-4 {{ $group['columns'] > 1 ? 'lg:grid-cols-2' : '' }}">
        @foreach ($group['sections'] as $section)
            <section>
                <h2 class="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{{ $section['heading'] }}</h2>
                <p class="mb-3 text-xs text-slate-500 dark:text-slate-400">{{ $section['description'] }}</p>

                <div class="grid gap-3 {{ $section['visiblePowerStates'] > 1 ? 'sm:grid-cols-2' : '' }}">
                    @foreach ($section['cards'] as $card)
                        <div class="rounded-lg border {{ $card['tone'] }} p-4" data-its-key="{{ $comparisonKey($card['comparison']) }}" data-scope="{{ $card['comparison']['scope'] }}">
                            <div class="flex items-center gap-2">
                                <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background-color: {{ $modeColours[$card['comparison']['mode']] }}"></span>
                                <span class="text-xs font-semibold text-slate-900 dark:text-slate-100">{{ $comparisonLabel($card['comparison']) }}</span>
                                <span class="text-[10px] text-slate-500">vs fixed-time</span>
                            </div>
                            <div class="mt-0.5 flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                                <span>{{ $powerLabels[$card['comparison']['power_state']] }}</span>
                                <span class="font-mono normal-case tracking-normal text-slate-400">n={{ $card['comparison']['runs'] }} vs {{ $card['comparison']['baseline_runs'] }}</span>
                            </div>

                            <div class="mt-3 flex items-baseline gap-2">
                                <span class="text-3xl font-semibold leading-none {{ $card['figureTone'] }}">
                                    @if ($card['recoveryPairMetric'])
                                        {{-- The headline here is the SELECTED mode's own recovery time, not
                                             the delta vs fixed-time - fixed-time is supporting context (the
                                             "Recovery time (subject vs fixed-time)" row below), not the main
                                             attraction, and this stays meaningful even when fixed-time never
                                             recovered in the window and no delta can be computed at all. --}}
                                        {{ $card['recoverySubjectSeconds'] === null ? '—' : number_format($card['recoverySubjectSeconds'], 1).'s' }}
                                    @else
                                        {{ $fmtDelta($card['value'], $card['suffix']) }}
                                    @endif
                                </span>
                                <span class="inline-flex items-center gap-1 text-[11px] font-medium {{ $card['figureTone'] }}">
                                    @if ($card['recoveryPairMetric'])
                                        @if ($card['recoverySubjectSeconds'] === null && $card['recoveryBaselineSeconds'] === null)
                                            neither side recovered in window
                                        @elseif ($card['recoverySubjectSeconds'] === null)
                                            did not recover in window
                                        @elseif ($card['recoveryBaselineSeconds'] === null)
                                            fixed-time did not recover in window
                                        @elseif ($card['improves'] === null)
                                            not measured yet
                                        @else
                                            <span aria-hidden="true">{{ $card['value'] >= 0 ? '▲' : '▼' }}</span>
                                            {{ $fmtDelta($card['value'], '%') }} {{ $card['improves'] ? $card['improvedLabel'] : $card['worseLabel'] }} than fixed-time
                                        @endif
                                    @elseif ($card['improves'] === null)
                                        not measured yet
                                    @else
                                        <span aria-hidden="true">{{ $card['value'] >= 0 ? '▲' : '▼' }}</span>
                                        {{ $card['improves'] ? $card['improvedLabel'] : $card['worseLabel'] }}
                                    @endif
                                </span>
                            </div>
                            <p class="mt-0.5 text-[10px] text-slate-500">{{ $section['unitLabel'] }}</p>

                            <dl class="mt-3 space-y-1 border-t border-slate-200 pt-2.5 text-[11px] dark:border-slate-800">
                                @foreach ($section['secondary'] as $secondary)
                                    <div class="flex justify-between gap-2">
                                        <dt class="text-slate-500">{{ $secondary['label'] }}</dt>
                                        <dd class="font-medium text-slate-800 dark:text-slate-200">
                                            {{ $fmtDelta($card['comparison'][$secondary['key']], $secondary['suffix']) }}
                                        </dd>
                                    </div>
                                @endforeach
                                @if ($card['recoveryPairMetric'] === 'wait')
                                    <div class="flex justify-between gap-2">
                                        <dt class="text-slate-500">Recovery time (subject vs fixed-time)</dt>
                                        <dd class="font-medium text-slate-800 dark:text-slate-200">
                                            {{ $fmtRecoverySide($card['recoverySubjectSeconds']) }} vs {{ $fmtRecoverySide($card['recoveryBaselineSeconds']) }}
                                        </dd>
                                    </div>
                                    <div class="flex justify-between gap-2">
                                        <dt class="text-slate-500">Post-recovery avg wait</dt>
                                        <dd class="font-medium text-slate-800 dark:text-slate-200">
                                            {{ $fmtSecondsPair($card['comparison']['post_recovery_avg_wait'], $card['comparison']['baseline_post_recovery_avg_wait']) }}
                                        </dd>
                                    </div>
                                @elseif ($card['recoveryPairMetric'] === 'throughput')
                                    <div class="flex justify-between gap-2">
                                        <dt class="text-slate-500">Recovery time (subject vs fixed-time)</dt>
                                        <dd class="font-medium text-slate-800 dark:text-slate-200">
                                            {{ $fmtRecoverySide($card['recoverySubjectSeconds']) }} vs {{ $fmtRecoverySide($card['recoveryBaselineSeconds']) }}
                                        </dd>
                                    </div>
                                    <div class="flex justify-between gap-2">
                                        <dt class="text-slate-500">Post-recovery throughput</dt>
                                        <dd class="font-medium text-slate-800 dark:text-slate-200">
                                            {{ $fmtSecondsPair($card['comparison']['post_recovery_throughput'], $card['comparison']['baseline_post_recovery_throughput'], ' veh/min') }}
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
@endforeach
