<?php

namespace App\Support;

use App\Models\SimulationRun;
use Illuminate\Support\Collection;

/**
 * Wait per road for the report's per-road table - read from each run's `road_waits` (engine.js's roadWaits): the
 * mean wait a vehicle built up on each road, over the vehicles that used it. Per road and power state, each
 * controller's mean (the sensors averaged per seed for the actuated modes), and the paired differences on the
 * same seeds: coordinated vs fixed-time, coordinated vs adaptive, and adaptive vs fixed-time, as % of the
 * baseline with a 95% CI. That locates where a controller's gain or loss sits - a main road or the streets crossing it.
 * Empty for batches from before the per-road waits were recorded.
 */
class RoadWaitMetrics
{
    private const MODES = ['fixed', 'adaptive', 'green_wave', 'coordinated_adaptive'];

    private const PAIRS = [
        'coordinated_vs_fixed' => ['coordinated_adaptive', 'fixed'],
        'coordinated_vs_adaptive' => ['coordinated_adaptive', 'adaptive'],
        'adaptive_vs_fixed' => ['adaptive', 'fixed'],
    ];

    /** Fewest seed pairs worth an interval. */
    private const MIN_PAIRS = 3;

    /**
     * @param  Collection<int, string>  $batchIds
     * @return array<int, array<string, mixed>>
     */
    public function forBatches(Collection $batchIds): array
    {
        $runs = SimulationRun::query()
            ->whereIn('batch_id', $batchIds)
            ->whereNotNull('road_waits')
            ->get(['controller_mode', 'power_state', 'corridor_config', 'seed', 'road_waits'])
            ->toBase();

        // seed -> one road's mean wait per (corridor, power, seed, mode): the sensors averaged for the actuated modes.
        $perSeed = [];
        $roads = [];
        foreach ($runs->groupBy(fn (SimulationRun $run): string => "{$run->corridor_config}|{$run->power_state}|{$run->seed}|{$run->controller_mode}") as $key => $group) {
            [$corridor, $power, $seed, $mode] = explode('|', $key);
            foreach ($group as $run) {
                foreach ($run->road_waits as $roadId => $road) {
                    $roads[$roadId] ??= ['name' => $road['name'], 'scope' => $road['scope']];
                    $perSeed[$power][$roadId][$mode]["{$corridor}:{$seed}"][] = $road['meanWait'];
                }
            }
        }

        $rows = [];
        foreach ($perSeed as $power => $byRoad) {
            foreach ($byRoad as $roadId => $byMode) {
                $means = collect($byMode)->map(fn (array $seeds): array => collect($seeds)->map(fn (array $waits): float => array_sum($waits) / count($waits))->all());
                $row = ['road_id' => $roadId, 'name' => $roads[$roadId]['name'], 'scope' => $roads[$roadId]['scope'], 'power_state' => $power];
                foreach (self::MODES as $mode) {
                    $row[$mode] = isset($means[$mode]) ? round(collect($means[$mode])->avg(), 1) : null;
                }
                foreach (self::PAIRS as $label => [$subject, $baseline]) {
                    $row[$label] = $this->paired($means[$subject] ?? [], $means[$baseline] ?? []);
                }
                $rows[] = $row;
            }
        }

        return collect($rows)
            ->sortBy([['scope', 'asc'], ['name', 'asc'], ['power_state', 'asc']])
            ->values()
            ->all();
    }

    /**
     * @param  array<string|int, float>  $subject  seed => mean wait
     * @param  array<string|int, float>  $baseline  seed => mean wait
     * @return array{delta: float, ci95: float}|null
     */
    private function paired(array $subject, array $baseline): ?array
    {
        $seeds = array_intersect_key($subject, $baseline);
        if (count($seeds) < self::MIN_PAIRS) {
            return null;
        }

        $differences = collect($seeds)->map(fn (float $wait, string $seed): float => $wait - $baseline[$seed])->values();
        $baselineMean = collect($seeds)->map(fn (float $wait, string $seed): float => $baseline[$seed])->avg();
        if ($baselineMean == 0.0) {
            return null;
        }

        $mean = $differences->avg();
        $variance = $differences->sum(fn (float $d): float => ($d - $mean) ** 2) / ($differences->count() - 1);

        return [
            'delta' => round($mean / $baselineMean * 100, 1) + 0.0,
            'ci95' => round(ConfidenceInterval::halfWidth95(sqrt($variance), $differences->count()) / $baselineMean * 100, 1) + 0.0,
        ];
    }
}
