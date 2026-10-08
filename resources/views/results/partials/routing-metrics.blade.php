{{-- Destination routing's trip figures - shared by the initial render and ResultsController::data()'s AJAX refresh. Empty for random-turning batches. --}}
@if ($routingMetrics)
    <section class="mb-8">
        <h2 class="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Destination routing - trips</h2>
        <p class="mb-3 text-xs text-slate-500 dark:text-slate-400">
            Every car drives a trip to a destination: a driveway on a block, or a way out of the map. Trip delay is a trip's
            time beyond free-flow driving along its route, over the trips that reached the destination they set out for.
            Missed driveways are pull-offs that didn't make their driveway first time (wrong lane, or no gap in oncoming
            traffic); diverted trips ended somewhere else altogether.
        </p>
        <div class="overflow-x-auto {{ $card }}">
            <table class="w-full min-w-[820px] text-left text-xs">
                <thead class="{{ $tableHead }}">
                    <tr>
                        <th scope="col" class="px-4 py-2 font-semibold">Controller mode</th>
                        <th scope="col" class="px-4 py-2 font-semibold">Power state</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">Runs</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">Mean trip (s)</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">Trip delay (s)</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">Missed driveways (%)</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">Missed turns / run</th>
                        <th scope="col" class="px-4 py-2 text-right font-semibold">Diverted (%)</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-slate-200 tabular-nums dark:divide-slate-800">
                    @foreach ($routingMetrics as $row)
                        <tr class="text-slate-700 dark:text-slate-300">
                            <th scope="row" class="whitespace-nowrap px-4 py-2 font-medium text-slate-900 dark:text-slate-200">
                                <span class="me-2 inline-block h-2 w-2 rounded-full align-middle" style="background-color: {{ $modeColours[$row['controller_mode']] }}"></span>
                                {{ $modeLabels[$row['controller_mode']] }}
                            </th>
                            <td class="px-4 py-2">{{ $row['power_state'] === 'load_shedding' ? 'Load shedding' : 'Normal' }}</td>
                            <td class="px-4 py-2 text-right">{{ $row['runs'] }}</td>
                            <td class="px-4 py-2 text-right">{{ $row['mean_trip_time'] === null ? '—' : number_format($row['mean_trip_time'], 1) }}</td>
                            <td class="px-4 py-2 text-right">{{ $row['mean_trip_delay'] === null ? '—' : number_format($row['mean_trip_delay'], 1) }}</td>
                            <td class="px-4 py-2 text-right">{{ $row['missed_driveways_pct'] === null ? '—' : number_format($row['missed_driveways_pct'], 1) }}</td>
                            <td class="px-4 py-2 text-right">{{ $row['missed_turns_per_run'] === null ? '—' : number_format($row['missed_turns_per_run'], 0) }}</td>
                            <td class="px-4 py-2 text-right">{{ $row['diversion_pct'] === null ? '—' : number_format($row['diversion_pct'], 1) }}</td>
                        </tr>
                    @endforeach
                </tbody>
            </table>
        </div>
    </section>
@endif
