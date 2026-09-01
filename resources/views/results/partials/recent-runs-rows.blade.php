{{-- Recent runs table body - shared by the initial render and ResultsController::data()'s AJAX refresh. --}}
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
