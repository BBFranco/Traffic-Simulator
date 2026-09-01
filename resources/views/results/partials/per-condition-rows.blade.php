{{-- Per-condition means table body - shared by the initial render and ResultsController::data()'s AJAX refresh. --}}
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
