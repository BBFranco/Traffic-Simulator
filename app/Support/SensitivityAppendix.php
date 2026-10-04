<?php

namespace App\Support;

use App\Enums\BatchKind;
use App\Enums\RoutingMode;
use App\Models\SimulationRun;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Collection;

/**
 * The report appendix for the latest sensitivity batch: each controller under the sensitivity's
 * signal-timing rules against the same controller in the main batch on the same seeds, and
 * green wave against fixed-time within each. The headline always stays on the main batch.
 */
class SensitivityAppendix
{
    public function __construct(private readonly SeedPairedDeltas $seedPairedDeltas) {}

    /** @return array<string, mixed>|null */
    public function forCorridor(?string $corridorFilter, RoutingMode $routingMode, Collection $mainBatchIds): ?array
    {
        $latest = SimulationRun::query()
            ->where('batch_kind', BatchKind::Sensitivity->value)
            ->where('routing_mode', $routingMode->value)
            ->when($corridorFilter, fn (Builder $query) => $query->where('corridor_config', $corridorFilter))
            ->latest('id')
            ->first();
        if ($latest === null) {
            return null;
        }

        $sensitivityRuns = SimulationRun::query()->where('batch_id', $latest->batch_id)->get()->toBase();
        $mainRuns = SimulationRun::query()
            ->whereIn('batch_id', $mainBatchIds)
            ->where('corridor_config', $latest->corridor_config)
            ->whereIn('seed', $sensitivityRuns->pluck('seed')->unique())
            ->get()
            ->toBase();

        $conditionKey = fn (SimulationRun $run): string => "{$run->controller_mode}|{$run->power_state}";
        $mainBySeed = $mainRuns->filter(fn (SimulationRun $run): bool => $run->controller_mode !== 'adaptive' || $run->sensor_mode === 'inductive_loop')
            ->keyBy(fn (SimulationRun $run): string => "{$conditionKey($run)}|{$run->seed}");

        $rows = $sensitivityRuns->groupBy($conditionKey)->map(function (Collection $runs, string $key) use ($mainBySeed): array {
            [$mode, $power] = explode('|', $key);
            $pairs = $runs->map(fn (SimulationRun $run): array => [
                'sensitivity' => $run->avg_wait_time,
                'main' => $mainBySeed->get("{$key}|{$run->seed}")?->avg_wait_time,
            ])->filter(fn (array $pair): bool => $pair['main'] !== null)->values();

            return [
                'controller_mode' => $mode,
                'power_state' => $power,
                'runs' => $runs->count(),
                'sensitivity_avg_wait' => round($runs->avg('avg_wait_time'), 1),
                'main_avg_wait_same_seeds' => $pairs->isEmpty() ? null : round($pairs->avg('main'), 1),
                'vs_main' => $this->pairedPct($pairs),
            ];
        })->values()->all();

        $config = $latest->raw_config_json ?? [];

        return [
            'label' => ($config['controllerConfig']['websterTurnInput'] ?? 'unknown rules').' · code '.($config['build']['commit'] ?? 'not recorded').(($config['build']['dirty'] ?? true) ? ' (uncommitted changes)' : ' (clean tree)'),
            'controllerConfig' => $config['controllerConfig'] ?? null,
            'rows' => $rows,
            'greenWaveVsFixed' => [
                'sensitivity' => $this->greenWaveVsFixed(collect([$latest->batch_id]), $latest->power_state),
                'main' => $this->greenWaveVsFixed($mainBatchIds, $latest->power_state),
            ],
        ];
    }

    /** @return array{delta: float, ci95: float, pairs: int}|null */
    private function greenWaveVsFixed(Collection $batchIds, string $power): ?array
    {
        return $this->seedPairedDeltas->forBatches($batchIds)["green_wave||{$power}"]['avg_wait_time'] ?? null;
    }

    /**
     * Mean per-seed difference as a % of the main batch's mean, with its 95% CI.
     *
     * @param  Collection<int, array{sensitivity: float, main: float}>  $pairs
     * @return array{delta: float, ci95: float, pairs: int}|null
     */
    private function pairedPct(Collection $pairs): ?array
    {
        if ($pairs->count() < 3 || $pairs->avg('main') == 0.0) {
            return null;
        }

        $differences = $pairs->map(fn (array $pair): float => $pair['sensitivity'] - $pair['main']);
        $mean = $differences->avg();
        $variance = $differences->sum(fn (float $d): float => ($d - $mean) ** 2) / ($differences->count() - 1);
        $baselineMean = $pairs->avg('main');

        return [
            'delta' => round($mean / $baselineMean * 100, 1) + 0.0,
            'ci95' => round(1.96 * sqrt($variance) / sqrt($differences->count()) / $baselineMean * 100, 1) + 0.0,
            'pairs' => $pairs->count(),
        ];
    }
}
