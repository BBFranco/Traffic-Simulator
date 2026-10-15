<?php

namespace App\Support;

use App\Models\SimulationRun;
use Illuminate\Support\Collection;

/**
 * What coordinated adaptive actually did, for the report's coordination section - read from each run's
 * `coordination_stats` (controllers/coordinationStats.js). Per sensor and power state: how much of the time the
 * junctions were married, the common cycle on the routes that coordinated (each arterial, and connector routes like Jan Shoba), how often self-tuning re-planned,
 * the resync holds, the platoon messages, and how greens ended. Per junction: its married share at normal power.
 * Empty for batches without coordinated adaptive, or from before these were recorded.
 */
class CoordinationMetrics
{
    /**
     * @param  Collection<int, string>  $batchIds
     * @return array{conditions: array<int, array<string, mixed>>, junctions: array<int, array<string, mixed>>}
     */
    public function forBatches(Collection $batchIds): array
    {
        $runs = SimulationRun::query()
            ->whereIn('batch_id', $batchIds)
            ->where('controller_mode', 'coordinated_adaptive')
            ->whereNotNull('coordination_stats')
            ->get(['sensor_mode', 'power_state', 'coordination_stats', 'raw_config_json']);

        return [
            'conditions' => $runs->groupBy(fn (SimulationRun $run): string => "{$run->sensor_mode}|{$run->power_state}")
                ->map(fn (Collection $group): array => $this->condition($group))
                ->values()
                ->all(),
            'junctions' => $this->junctions($runs->where('power_state', 'normal')),
        ];
    }

    /** @param  Collection<int, SimulationRun>  $runs */
    private function condition(Collection $runs): array
    {
        $first = $runs->first();
        $perHour = fn (callable $value): ?float => $this->mean($runs->map(fn (SimulationRun $run): ?float => $this->measuredHours($run) ? $value($run->coordination_stats) / $this->measuredHours($run) : null));
        $greenEnds = $runs->flatMap(fn (SimulationRun $run): array => $run->coordination_stats['greenEnds'] ?? [])
            ->keys()
            ->unique()
            ->mapWithKeys(fn (string $reason): array => [$reason => $runs->sum(fn (SimulationRun $run): int => $run->coordination_stats['greenEnds'][$reason] ?? 0)]);
        $allEnds = $greenEnds->sum();

        return [
            'sensor_mode' => $first->sensor_mode,
            'power_state' => $first->power_state,
            'runs' => $runs->count(),
            'married_pct' => $this->mean($runs->map(fn (SimulationRun $run): ?float => $this->percent($run->coordination_stats['marriedShare'] ?? null))),
            'mean_cycle_s' => $this->mean($runs->map(fn (SimulationRun $run): ?float => $this->marriedCycle($run->coordination_stats))),
            'retunes_per_hour' => $perHour(fn (array $stats): float => collect($stats['routes'] ?? [])->sum('retunes')),
            'recovery_holds' => $this->mean($runs->map(fn (SimulationRun $run): float => (float) ($run->coordination_stats['recoveryHolds'] ?? 0))),
            'messages_per_hour' => $perHour(fn (array $stats): float => (float) ($stats['platoon']['messages'] ?? 0)),
            'holds_per_hour' => $perHour(fn (array $stats): float => (float) ($stats['platoon']['holds'] ?? 0)),
            'early_ends_per_hour' => $perHour(fn (array $stats): float => (float) ($stats['greenEnds']['platoonEarly'] ?? 0)),
            'green_ends_pct' => $allEnds ? $greenEnds->map(fn (int $count): float => round($count / $allEnds * 100, 1))->sortDesc()->all() : [],
        ];
    }

    /**
     * Per junction at normal power, every sensor pooled: married share, and the mean common cycle of the route it coordinated on.
     *
     * @param  Collection<int, SimulationRun>  $runs
     * @return array<int, array{node_id: string, route_id: string, married_pct: ?float, mean_cycle_s: ?float}>
     */
    private function junctions(Collection $runs): array
    {
        return $runs->flatMap(fn (SimulationRun $run): array => collect($run->coordination_stats['nodes'] ?? [])
            ->map(fn (array $node, string $nodeId): array => [
                'node_id' => $nodeId,
                'route_id' => $node['routeId'],
                'married_share' => $node['marriedShare'],
                'cycle_s' => $run->coordination_stats['routes'][$node['routeId']]['meanCycleS'] ?? null,
            ])
            ->values()
            ->all())
            ->groupBy('node_id')
            ->map(fn (Collection $samples, string $nodeId): array => [
                'node_id' => $nodeId,
                'route_id' => $samples->first()['route_id'],
                'married_pct' => $this->mean($samples->map(fn (array $sample): ?float => $this->percent($sample['married_share']))),
                'mean_cycle_s' => $this->mean($samples->pluck('cycle_s')),
            ])
            ->sortByDesc('married_pct')
            ->values()
            ->all();
    }

    /** Mean common cycle over the routes where some junction was married - elsewhere the cycle drove nothing. */
    private function marriedCycle(array $stats): ?float
    {
        $marriedRoutes = collect($stats['nodes'] ?? [])->filter(fn (array $node): bool => ($node['marriedShare'] ?? 0) > 0)->pluck('routeId')->unique();

        return $this->mean($marriedRoutes->map(fn (string $routeId): ?float => $stats['routes'][$routeId]['meanCycleS'] ?? null));
    }

    private function measuredHours(SimulationRun $run): float
    {
        $config = $run->raw_config_json ?? [];

        return ($config['durationTicks'] ?? 0) * ($config['dt'] ?? 0) / 3600;
    }

    /** @param  Collection<int, float|null>  $values */
    private function mean(Collection $values): ?float
    {
        $present = $values->filter(fn (?float $value): bool => $value !== null);

        return $present->isEmpty() ? null : round($present->avg(), 1);
    }

    private function percent(int|float|null $share): ?float
    {
        return $share === null ? null : $share * 100;
    }
}
