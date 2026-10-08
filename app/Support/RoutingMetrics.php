<?php

namespace App\Support;

use App\Models\SimulationRun;
use Illuminate\Support\Collection;

/**
 * Destination routing's per-condition figures for the Results page: trip time,
 * trip delay over free flow, and how often a trip didn't go to plan. Empty for
 * random-turning batches, which store no routing metrics.
 */
class RoutingMetrics
{
    /**
     * @param  Collection<int, string>  $batchIds
     * @return array<int, array{controller_mode: string, power_state: string, runs: int, mean_trip_time: ?float, mean_trip_delay: ?float, missed_driveways_pct: ?float, missed_turns_per_run: ?float, diversion_pct: ?float, mean_driveway_wait: ?float, still_in_driveways: ?float, arrivals_lost_per_run: ?float}>
     */
    public function forBatches(Collection $batchIds): array
    {
        return SimulationRun::query()
            ->whereIn('batch_id', $batchIds)
            ->whereNotNull('trips')
            ->selectRaw('controller_mode, power_state, count(*) as runs, avg(mean_trip_time) as mean_trip_time, avg(mean_trip_delay) as mean_trip_delay, sum(missed_driveways) as missed_driveways, sum(pulled_off) as pulled_off, avg(missed_turns) as missed_turns, avg(diversion_pct) as diversion_pct')
            // Null on runs from before driveway waits and lost demand were recorded.
            ->selectRaw("avg(json_extract(routing_stats, '$.meanDrivewayWaitS')) as mean_driveway_wait, avg(json_extract(routing_stats, '$.departuresWaiting')) as still_in_driveways, avg(json_extract(diagnostics, '$.arrivalsLost')) as arrivals_lost")
            ->groupBy('controller_mode', 'power_state')
            ->get()
            ->map(fn (object $row) => [
                'controller_mode' => $row->controller_mode,
                'power_state' => $row->power_state,
                'runs' => (int) $row->runs,
                'mean_trip_time' => $this->float($row->mean_trip_time),
                'mean_trip_delay' => $this->float($row->mean_trip_delay),
                'missed_driveways_pct' => $row->pulled_off > 0 ? ($row->missed_driveways / $row->pulled_off) * 100 : null,
                'missed_turns_per_run' => $this->float($row->missed_turns),
                'diversion_pct' => $this->float($row->diversion_pct),
                'mean_driveway_wait' => $this->float($row->mean_driveway_wait),
                'still_in_driveways' => $this->float($row->still_in_driveways),
                'arrivals_lost_per_run' => $this->float($row->arrivals_lost),
            ])
            ->all();
    }

    private function float(mixed $value): ?float
    {
        return $value === null ? null : (float) $value;
    }
}
