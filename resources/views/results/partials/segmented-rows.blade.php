{{-- Load-shedding segmented table body - shared by the initial render and ResultsController::data()'s AJAX refresh. --}}
@foreach ($controllerModes as $mode)
    @if ($row = $byModeAndPower["{$mode}|load_shedding"] ?? null)
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
