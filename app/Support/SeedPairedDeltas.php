<?php

namespace App\Support;

use App\Enums\ControllerMode;
use App\Models\SimulationRun;
use Illuminate\Support\Collection;

/**
 * Each ITS condition against fixed-time on the same seeds: the mean of the per-seed differences
 * and its 95% confidence half-width. Seeds are shared across controllers (seedForRep), so the
 * per-seed difference cancels the seed-to-seed noise both sides share - a far tighter interval
 * than putting the two conditions' own CIs side by side.
 *
 * Keyed "mode|sensor|power" (sensor 'average' for adaptive across its sensors, '' for green wave),
 * then by column: `delta` in % of the fixed-time mean (pp for cleared-without-stop) and `ci95` in
 * the same unit. Recovery columns pair only seeds where both sides recovered. The zone scopes (`<metric>_zone1`...)
 * read from each run's zone_stats (ZoneScopes) and pair the same way.
 */
class SeedPairedDeltas
{
    private const SCOPED_COLUMNS = ['avg_wait_time', 'throughput_per_min', 'pct_cleared_without_stop', 'time_to_recovery_seconds', 'time_to_recovery_wait_seconds'];

    private const TOTAL_ONLY_COLUMNS = ['median_wait_time', 'p95_wait_time', 'max_wait_time'];

    /** The tail per scope too (the median is stored for the total scope only). */
    private const SCOPED_TAIL_COLUMNS = ['p95_wait_time_arterial', 'max_wait_time_arterial', 'p95_wait_time_side_street', 'max_wait_time_side_street'];

    /** What coordinated adaptive is read against adaptive on: the wait in every scope, its tail, throughput, cleared-without-stop and recovery. */
    private const VERSUS_ADAPTIVE_COLUMNS = [
        'avg_wait_time', 'avg_wait_time_arterial', 'avg_wait_time_side_street',
        'p95_wait_time', 'p95_wait_time_arterial', 'p95_wait_time_side_street', 'max_wait_time_side_street',
        'throughput_per_min', 'pct_cleared_without_stop', 'time_to_recovery_seconds',
    ];

    private const SCOPE_SUFFIXES = ['', '_arterial', '_side_street'];

    /** What each zone scope pairs on - its mean wait and tail, throughput, cleared-without-stop and recovery. */
    private const ZONE_METRICS = ['avg_wait_time', 'throughput_per_min', 'pct_cleared_without_stop', 'time_to_recovery_seconds', 'time_to_recovery_wait_seconds', 'median_wait_time', 'p95_wait_time', 'max_wait_time'];

    public function __construct(private readonly ZoneScopes $zoneScopes) {}

    /** Percentage-point columns: the difference itself, not a share of the baseline. */
    private const POINT_COLUMNS = ['pct_cleared_without_stop'];

    /** Fewest seed pairs worth an interval. */
    private const MIN_PAIRS = 3;

    /**
     * @param  Collection<int, string>  $batchIds
     * @return array<string, array<string, array{delta: float, ci95: float, pairs: int}>>
     */
    public function forBatches(Collection $batchIds): array
    {
        $columns = [...$this->columns(), ...$this->zoneScopes->columns(self::ZONE_METRICS)];
        $runs = SimulationRun::query()
            ->whereIn('batch_id', $batchIds)
            ->get(['controller_mode', 'sensor_mode', 'power_state', 'corridor_config', 'seed', 'zone_stats', ...$this->columns()])
            ->toBase();

        $pairKey = fn (SimulationRun $run): string => "{$run->corridor_config}|{$run->power_state->value}|{$run->seed}";
        $baselines = $runs->where('controller_mode', 'fixed')->keyBy($pairKey);

        $splitsBySensor = fn (SimulationRun $run): bool => ControllerMode::from($run->controller_mode)->splitsBySensor();
        $subjects = $runs->where('controller_mode', '!=', 'fixed')
            // Only the actuated modes vary by sensor - green wave runs carry a sensor mode they never read.
            ->groupBy(fn (SimulationRun $run): string => $splitsBySensor($run)
                ? "{$run->controller_mode}|{$run->sensor_mode}|{$run->power_state->value}"
                : "{$run->controller_mode}||{$run->power_state->value}");
        // An actuated mode across its sensors: the sensors' mean per seed, paired like any single condition.
        $sensorAverages = $runs->filter($splitsBySensor)
            ->groupBy(fn (SimulationRun $run): string => "{$run->controller_mode}|average|{$run->power_state->value}");

        return $subjects->merge($sensorAverages)
            ->map(fn (Collection $group): array => collect($columns)
                ->mapWithKeys(fn (string $column): array => [$column => $this->pairedDelta($group, $baselines, $pairKey, $column)])
                ->filter()
                ->all())
            ->all();
    }

    /**
     * Coordinated adaptive against adaptive on the same seeds and sensor (the sensors' mean per seed for the 'average' row),
     * in the same shape as forBatches(), keyed "sensor|power".
     *
     * @param  Collection<int, string>  $batchIds
     * @return array<string, array<string, array{delta: float, ci95: float, pairs: int}>>
     */
    public function versusAdaptive(Collection $batchIds): array
    {
        $columns = self::VERSUS_ADAPTIVE_COLUMNS;
        $runs = SimulationRun::query()
            ->whereIn('batch_id', $batchIds)
            ->whereIn('controller_mode', ['adaptive', 'coordinated_adaptive'])
            ->get(['controller_mode', 'sensor_mode', 'power_state', 'corridor_config', 'seed', ...$columns])
            ->toBase();
        $adaptive = $runs->where('controller_mode', 'adaptive');
        $coordinated = $runs->where('controller_mode', 'coordinated_adaptive');

        $perSensorKey = fn (SimulationRun $run): string => "{$run->corridor_config}|{$run->power_state->value}|{$run->seed}|{$run->sensor_mode}";
        $perSeedKey = fn (SimulationRun $run): string => "{$run->corridor_config}|{$run->power_state->value}|{$run->seed}";
        $sensorBaselines = $adaptive->keyBy($perSensorKey);
        $averageBaselines = $adaptive->groupBy($perSeedKey)->map(fn (Collection $group): object => (object) collect($columns)
            ->mapWithKeys(fn (string $column): array => [$column => $group->pluck($column)->filter(fn ($value): bool => $value !== null)->avg()])
            ->all());

        $result = [];
        foreach ($coordinated->groupBy(fn (SimulationRun $run): string => "{$run->sensor_mode}|{$run->power_state->value}") as $key => $group) {
            $result[$key] = $this->pairedColumns($group, $sensorBaselines, $perSensorKey, $columns);
        }
        foreach ($coordinated->groupBy(fn (SimulationRun $run): string => "average|{$run->power_state->value}") as $key => $group) {
            $result[$key] = $this->pairedColumns($group, $averageBaselines, $perSeedKey, $columns);
        }

        return $result;
    }

    /** @return array<string, array{delta: float, ci95: float, pairs: int}> */
    private function pairedColumns(Collection $group, Collection $baselines, callable $pairKey, array $columns): array
    {
        return collect($columns)
            ->mapWithKeys(fn (string $column): array => [$column => $this->pairedDelta($group, $baselines, $pairKey, $column)])
            ->filter()
            ->all();
    }

    /**
     * @param  Collection<int, SimulationRun>  $group
     * @param  Collection<string, SimulationRun|object>  $baselines
     * @return array{delta: float, ci95: float, pairs: int}|null
     */
    private function pairedDelta(Collection $group, Collection $baselines, callable $pairKey, string $column): ?array
    {
        $pairs = $group->groupBy($pairKey)
            ->map(fn (Collection $seedRuns, string $key): ?array => [
                'subject' => $seedRuns->map(fn (SimulationRun $run): ?float => $this->value($run, $column))->filter(fn ($value): bool => $value !== null)->avg(),
                'baseline' => $this->value($baselines->get($key), $column),
            ])
            ->filter(fn (array $pair): bool => $pair['subject'] !== null && $pair['baseline'] !== null)
            ->values();

        if ($pairs->count() < self::MIN_PAIRS) {
            return null;
        }

        $differences = $pairs->map(fn (array $pair): float => $pair['subject'] - $pair['baseline']);
        $meanDifference = $differences->avg();
        $variance = $differences->sum(fn (float $d): float => ($d - $meanDifference) ** 2) / ($differences->count() - 1);
        $halfWidth = ConfidenceInterval::halfWidth95(sqrt($variance), $differences->count());

        if (in_array($this->baseColumn($column), self::POINT_COLUMNS, true)) {
            return ['delta' => $this->round($meanDifference), 'ci95' => $this->round($halfWidth), 'pairs' => $pairs->count()];
        }

        $baselineMean = $pairs->avg('baseline');
        if ($baselineMean == 0.0) {
            return null;
        }

        return [
            'delta' => $this->round($meanDifference / $baselineMean * 100),
            'ci95' => $this->round($halfWidth / $baselineMean * 100),
            'pairs' => $pairs->count(),
        ];
    }

    /** One decimal, and never "-0.0". */
    private function round(float $value): float
    {
        return round($value, 1) + 0.0;
    }

    /** @return array<int, string> */
    private function columns(): array
    {
        return collect(self::SCOPED_COLUMNS)
            ->crossJoin(self::SCOPE_SUFFIXES)
            ->map(fn (array $parts): string => $parts[0].$parts[1])
            ->merge(self::TOTAL_ONLY_COLUMNS)
            ->merge(self::SCOPED_TAIL_COLUMNS)
            ->all();
    }

    private function baseColumn(string $column): string
    {
        return str_replace(['_arterial', '_side_street', ...array_keys(ZoneScopes::SUFFIXES)], '', $column);
    }

    /** A column's value on a run (a zone column from its zone_stats), or on versusAdaptive()'s per-seed average. */
    private function value(?object $run, string $column): ?float
    {
        if ($run instanceof SimulationRun && $this->zoneScopes->isZoneColumn($column)) {
            return $this->zoneScopes->value($run, $column);
        }

        return $run?->{$column};
    }
}
