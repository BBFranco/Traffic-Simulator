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
 * green wave against fixed-time under each set of rules - mean, median, P95 and the two scopes.
 * The headline always stays on the main batch.
 */
class SensitivityAppendix
{
    /** Wait columns shown, in order: the mean, the tail, then where the wait built up. */
    private const WAIT_COLUMNS = [
        'avg_wait_time' => 'Mean',
        'median_wait_time' => 'Median',
        'p95_wait_time' => 'P95',
        'avg_wait_time_arterial' => 'Mean, main arterial',
        'avg_wait_time_side_street' => 'Mean, side streets',
    ];

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

        $rows = $sensitivityRuns->groupBy($conditionKey)->flatMap(function (Collection $runs, string $key) use ($mainBySeed): array {
            [$mode, $power] = explode('|', $key);

            return collect(self::WAIT_COLUMNS)->map(function (string $label, string $column) use ($runs, $mainBySeed, $key, $mode, $power): array {
                $pairs = $runs->map(fn (SimulationRun $run): array => [
                    'sensitivity' => $run->{$column},
                    'main' => $mainBySeed->get("{$key}|{$run->seed}")?->{$column},
                ])->filter(fn (array $pair): bool => $pair['sensitivity'] !== null && $pair['main'] !== null)->values();

                return [
                    'controller_mode' => $mode,
                    'power_state' => $power,
                    'metric' => $label,
                    'runs' => $runs->count(),
                    'sensitivity' => $pairs->isEmpty() ? null : round($pairs->avg('sensitivity'), 1),
                    'main_same_seeds' => $pairs->isEmpty() ? null : round($pairs->avg('main'), 1),
                    'vs_main' => $this->pairedPct($pairs),
                ];
            })->values()->all();
        })->values()->all();

        $config = $latest->raw_config_json ?? [];
        $sensitivityDeltas = $this->seedPairedDeltas->forBatches(collect([$latest->batch_id]))["green_wave||{$latest->power_state}"] ?? [];
        $mainDeltas = $this->seedPairedDeltas->forBatches($mainBatchIds)["green_wave||{$latest->power_state}"] ?? [];

        return [
            'label' => $this->stampLabel($config, $sensitivityRuns),
            'controllerConfig' => $config['controllerConfig'] ?? null,
            'rows' => $rows,
            'greenWaveVsFixed' => collect(self::WAIT_COLUMNS)->map(fn (string $label, string $column): array => [
                'metric' => $label,
                'sensitivity' => $sensitivityDeltas[$column] ?? null,
                'main' => $mainDeltas[$column] ?? null,
            ])->values()->all(),
        ];
    }

    /** The sensitivity batch's own stamp - code, signal rules, timing, seeds - so it can never pass for the main batch. */
    private function stampLabel(array $config, Collection $runs): string
    {
        $build = $config['build'] ?? [];
        $controllers = $config['controllerConfig'] ?? [];
        $minutes = fn (?int $ticks): ?int => $ticks === null ? null : (int) round($ticks * ($config['dt'] ?? 0.1) / 60);

        return collect([
            'SENSITIVITY BATCH',
            'Webster turn input '.($controllers['websterTurnInput'] ?? 'not recorded').' (fixed-time and green wave)',
            'turn weight on '.($controllers['turnWeightActsOn'] ?? 'not recorded'),
            'code '.($build['commit'] ?? 'not recorded').(($build['dirty'] ?? true) ? ' (uncommitted changes)' : ' (clean tree)'),
            'wait accounting '.($config['waitAccounting'] ?? 'not recorded'),
            "{$minutes($config['warmupTicks'] ?? null)} min warm-up + {$minutes($config['durationTicks'] ?? null)} min measured",
            'seeds '.$runs->min('seed').'-'.$runs->max('seed'),
        ])->implode(' · ');
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
            'ci95' => round(ConfidenceInterval::halfWidth95(sqrt($variance), $differences->count()) / $baselineMean * 100, 1) + 0.0,
            'pairs' => $pairs->count(),
        ];
    }
}
