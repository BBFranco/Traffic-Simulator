<?php

namespace App\Support;

use App\Models\SimulationRun;
use Illuminate\Support\Collection;

/**
 * One plain row per run of the batches shown, for the results report's appendix (resultsAppendix.js): the dissertation's
 * figures and tables are computed from these the same way its analysis scripts do, paired by seed.
 */
class AppendixRuns
{
    private const COLUMNS = [
        'seed', 'controller_mode', 'sensor_mode', 'power_state',
        'avg_wait_time', 'avg_wait_time_arterial', 'avg_wait_time_side_street',
        'throughput_per_min', 'pct_cleared_without_stop', 'pct_cleared_without_stop_arterial',
        'median_wait_time', 'p95_wait_time', 'max_wait_time',
        'avg_wait_time_pre_outage', 'avg_wait_time_during_outage', 'avg_wait_time_post_recovery',
        'avg_wait_time_stage1', 'avg_wait_time_stage2',
        'time_to_recovery_wait_seconds', 'mean_trip_time', 'mean_trip_delay',
    ];

    /**
     * @param  Collection<int, string>  $batchIds
     * @return array<int, array<string, mixed>>
     */
    public function forBatches(Collection $batchIds): array
    {
        return SimulationRun::query()
            ->whereIn('batch_id', $batchIds)
            ->orderBy('id')
            ->get([...self::COLUMNS, 'road_waits', 'diagnostics'])
            ->map(fn (SimulationRun $run): array => [
                ...collect(self::COLUMNS)->mapWithKeys(fn (string $column): array => [$column => $run->{$column}])->all(),
                'power_state' => $run->power_state->value,
                'road_waits' => collect($run->road_waits ?? [])
                    ->where('scope', 'arterial')
                    ->map(fn (array $road): ?float => $road['meanWait'] ?? null)
                    ->all(),
                'arrivals_lost' => $run->diagnostics['arrivalsLost'] ?? null,
                'delay_veh_h' => $run->diagnostics['delay']['totalVehH'] ?? null,
            ])
            ->all();
    }
}
