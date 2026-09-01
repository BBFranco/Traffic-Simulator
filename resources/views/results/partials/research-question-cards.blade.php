{{--
    "Does ITS beat fixed-time" cards - shared by results.blade.php's initial render and
    ResultsController::data()'s AJAX refresh (see that method's docblock for why this had to
    become a partial rather than staying inline).
--}}
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
