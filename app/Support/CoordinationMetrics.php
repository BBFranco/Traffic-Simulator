<?php

namespace App\Support;

use App\Enums\PowerState;
use App\Models\SimulationRun;
use Illuminate\Support\Collection;

/**
 * What coordinated adaptive actually did, for the report's coordination section - read from each run's
 * `coordination_stats` (controllers/coordinationStats.js). Per sensor and power state: how much of the time the
 * junctions were married, the common cycle on the routes that coordinated (each arterial, and connector routes like Jan Shoba), how often self-tuning re-planned,
 * the resync holds, the platoon messages, and how greens ended. Under an outage also Jan Shoba's married share and route
 * cycle per stage, and the resync holds per restore. Per junction: its married share per power state.
 * Empty for batches without coordinated adaptive, or from before these were recorded.
 */
class CoordinationMetrics
{
    /** The batch schedule's stages in time order (coordinationStats.js's byStage keys). */
    private const STAGES = ['pre', 'during', 'stage1', 'stage2', 'post'];

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
            'conditions' => $runs->groupBy(fn (SimulationRun $run): string => "{$run->sensor_mode}|{$run->power_state->value}")
                ->map(fn (Collection $group): array => $this->condition($group))
                ->values()
                ->all(),
            'junctions' => $this->junctions($runs),
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
            'power_state' => $first->power_state->value,
            'runs' => $runs->count(),
            'married_pct' => $this->mean($runs->map(fn (SimulationRun $run): ?float => $this->percent($run->coordination_stats['marriedShare'] ?? null))),
            'mean_cycle_s' => $this->mean($runs->map(fn (SimulationRun $run): ?float => $this->marriedCycle($run->coordination_stats))),
            'retunes_per_hour' => $perHour(fn (array $stats): float => collect($stats['routes'] ?? [])->sum('retunes')),
            'recovery_holds' => $this->mean($runs->map(fn (SimulationRun $run): float => (float) ($run->coordination_stats['recoveryHolds'] ?? 0))),
            'messages_per_hour' => $perHour(fn (array $stats): float => (float) ($stats['platoon']['messages'] ?? 0)),
            'holds_per_hour' => $perHour(fn (array $stats): float => (float) ($stats['platoon']['holds'] ?? 0)),
            'early_ends_per_hour' => $perHour(fn (array $stats): float => (float) ($stats['greenEnds']['platoonEarly'] ?? 0)),
            'green_ends_pct' => $allEnds ? $greenEnds->map(fn (int $count): float => round($count / $allEnds * 100, 1))->sortDesc()->all() : [],
            'by_stage' => $this->byStage($runs),
            'restores' => $this->restores($runs),
        ];
    }

    /**
     * Jan Shoba's signals per outage stage: married share and route cycle, each the runs' mean. Empty at normal power.
     *
     * @param  Collection<int, SimulationRun>  $runs
     * @return array<string, array{married_pct: ?float, route_cycle_s: ?float}>
     */
    private function byStage(Collection $runs): array
    {
        return collect(self::STAGES)
            ->filter(fn (string $stage): bool => $runs->contains(fn (SimulationRun $run): bool => isset($run->coordination_stats['byStage'][$stage])))
            ->mapWithKeys(fn (string $stage): array => [$stage => [
                'married_pct' => $this->mean($runs->map(fn (SimulationRun $run): ?float => $this->percent($run->coordination_stats['byStage'][$stage]['marriedShare'] ?? null))),
                'route_cycle_s' => $this->mean($runs->map(fn (SimulationRun $run): ?float => $run->coordination_stats['byStage'][$stage]['routeCycleS'] ?? null)),
            ]])
            ->all();
    }

    /**
     * The resync holds per power return, by the stage it started in: when (measured seconds), how long, and how many a
     * run had there. A rolling blackout has two returns, a total blackout one. Empty at normal power.
     *
     * @param  Collection<int, SimulationRun>  $runs
     * @return array<int, array{stage: ?string, at_s: ?float, hold_s: ?float, per_run: float}>
     */
    private function restores(Collection $runs): array
    {
        return $runs->flatMap(fn (SimulationRun $run): array => $run->coordination_stats['restores'] ?? [])
            ->groupBy(fn (array $restore): string => (string) ($restore['stage'] ?? ''))
            ->map(fn (Collection $restores, string $stage): array => [
                'stage' => $stage === '' ? null : $stage,
                'at_s' => $this->mean($restores->pluck('atS')),
                'hold_s' => $this->mean($restores->pluck('holdS')),
                'per_run' => round($restores->count() / $runs->count(), 1),
            ])
            ->sortBy(fn (array $restore): float => $restore['at_s'] ?? INF)
            ->values()
            ->all();
    }

    /**
     * Per junction, every sensor pooled: married share per power state (dark time counted as unmarried) - `married_pct`
     * and `married_pct_load_shedding` repeat the normal and total-blackout entries - and the mean common cycle of the
     * route it coordinated on at normal power.
     *
     * @param  Collection<int, SimulationRun>  $runs
     * @return array<int, array{node_id: string, route_id: string, married_pct: ?float, married_pct_load_shedding: ?float, married_pct_by_power: array<string, ?float>, mean_cycle_s: ?float}>
     */
    private function junctions(Collection $runs): array
    {
        $samples = fn (Collection $group): Collection => $group->flatMap(fn (SimulationRun $run): array => collect($run->coordination_stats['nodes'] ?? [])
            ->map(fn (array $node, string $nodeId): array => [
                'node_id' => $nodeId,
                'route_id' => $node['routeId'],
                'married_share' => $node['marriedShare'],
                'cycle_s' => $run->coordination_stats['routes'][$node['routeId']]['meanCycleS'] ?? null,
            ])
            ->values()
            ->all());
        $byPower = collect(PowerState::cases())
            ->mapWithKeys(fn (PowerState $power): array => [$power->value => $samples($runs->where('power_state', $power))->groupBy('node_id')]);
        $normal = $byPower[PowerState::Normal->value];
        $share = fn (?Collection $group): ?float => $group ? $this->mean($group->map(fn (array $sample): ?float => $this->percent($sample['married_share']))) : null;

        return $byPower->flatMap(fn (Collection $nodes): array => $nodes->keys()->all())->unique()
            ->map(fn (string $nodeId): array => [
                'node_id' => $nodeId,
                'route_id' => $byPower->first(fn (Collection $nodes): bool => isset($nodes[$nodeId]))[$nodeId]->first()['route_id'],
                'married_pct' => $share($normal[$nodeId] ?? null),
                'married_pct_load_shedding' => $share($byPower[PowerState::LoadShedding->value][$nodeId] ?? null),
                'married_pct_by_power' => $byPower->map(fn (Collection $nodes): ?float => $share($nodes[$nodeId] ?? null))->all(),
                'mean_cycle_s' => isset($normal[$nodeId]) ? $this->mean($normal[$nodeId]->pluck('cycle_s')) : null,
            ])
            ->pipe(function (Collection $junctions): Collection {
                // A route no junction married on ran no common cycle - its planned cycle drove nothing, so it is not shown.
                $marriedRoutes = $junctions->filter(fn (array $junction): bool => ($junction['married_pct'] ?? 0) > 0)->pluck('route_id')->unique();

                return $junctions->map(fn (array $junction): array => $marriedRoutes->contains($junction['route_id']) ? $junction : [...$junction, 'mean_cycle_s' => null]);
            })
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
