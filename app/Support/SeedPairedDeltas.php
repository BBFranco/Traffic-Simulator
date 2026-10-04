<?php

namespace App\Support;

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
 * the same unit. Recovery columns pair only seeds where both sides recovered.
 */
class SeedPairedDeltas
{
    private const SCOPED_COLUMNS = ['avg_wait_time', 'throughput_per_min', 'pct_cleared_without_stop', 'time_to_recovery_seconds', 'time_to_recovery_wait_seconds'];

    private const TOTAL_ONLY_COLUMNS = ['median_wait_time', 'p95_wait_time'];

    private const SCOPE_SUFFIXES = ['', '_arterial', '_side_street'];

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
        $columns = $this->columns();
        $runs = SimulationRun::query()
            ->whereIn('batch_id', $batchIds)
            ->get(['controller_mode', 'sensor_mode', 'power_state', 'corridor_config', 'seed', ...$columns])
            ->toBase();

        $pairKey = fn (SimulationRun $run): string => "{$run->corridor_config}|{$run->power_state}|{$run->seed}";
        $baselines = $runs->where('controller_mode', 'fixed')->keyBy($pairKey);

        $subjects = $runs->where('controller_mode', '!=', 'fixed')
            // Only adaptive varies by sensor - green wave runs carry a sensor mode they never read.
            ->groupBy(fn (SimulationRun $run): string => $run->controller_mode === 'adaptive'
                ? "adaptive|{$run->sensor_mode}|{$run->power_state}"
                : "{$run->controller_mode}||{$run->power_state}");
        // Adaptive across its sensors: the sensors' mean per seed, paired like any single condition.
        $adaptiveAverage = $runs->where('controller_mode', 'adaptive')
            ->groupBy(fn (SimulationRun $run): string => "adaptive|average|{$run->power_state}");

        return $subjects->merge($adaptiveAverage)
            ->map(fn (Collection $group): array => collect($columns)
                ->mapWithKeys(fn (string $column): array => [$column => $this->pairedDelta($group, $baselines, $pairKey, $column)])
                ->filter()
                ->all())
            ->all();
    }

    /**
     * @param  Collection<int, SimulationRun>  $group
     * @param  Collection<string, SimulationRun>  $baselines
     * @return array{delta: float, ci95: float, pairs: int}|null
     */
    private function pairedDelta(Collection $group, Collection $baselines, callable $pairKey, string $column): ?array
    {
        $pairs = $group->groupBy($pairKey)
            ->map(fn (Collection $seedRuns, string $key): ?array => [
                'subject' => $seedRuns->pluck($column)->filter(fn ($value): bool => $value !== null)->avg(),
                'baseline' => $baselines->get($key)?->{$column},
            ])
            ->filter(fn (array $pair): bool => $pair['subject'] !== null && $pair['baseline'] !== null)
            ->values();

        if ($pairs->count() < self::MIN_PAIRS) {
            return null;
        }

        $differences = $pairs->map(fn (array $pair): float => $pair['subject'] - $pair['baseline']);
        $meanDifference = $differences->avg();
        $variance = $differences->sum(fn (float $d): float => ($d - $meanDifference) ** 2) / ($differences->count() - 1);
        $halfWidth = 1.96 * sqrt($variance) / sqrt($differences->count());

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
            ->all();
    }

    private function baseColumn(string $column): string
    {
        return str_replace(['_arterial', '_side_street'], '', $column);
    }
}
