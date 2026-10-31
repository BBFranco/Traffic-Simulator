<?php

namespace App\Support;

use App\Enums\AdaptiveMaxArm;
use App\Enums\BatchKind;
use App\Enums\ControllerMode;
use App\Enums\PowerState;
use App\Enums\RoutingMode;
use App\Models\SimulationRun;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Collection;

/**
 * Figure A10's data (resultsAppendix.js): under load shedding, the seed-mean wait over the measured window and the
 * mean vehicles standing in zone 2, for fixed-time (the main batch) and adaptive with an inductive loop under each
 * maximum-green arm (the newest sensitivity batch of each). Null until both arms have been run.
 */
class AdaptiveMaxSensitivity
{
    private const SENSOR = 'inductive_loop';

    private const ZONE = '2';

    public function __construct(private LatestBatchIds $latestBatchIds) {}

    /** @return array<string, mixed>|null */
    public function for(?string $corridorFilter, RoutingMode $routingMode): ?array
    {
        $sartsmBatchId = $this->latestArmBatchId(AdaptiveMaxArm::Sartsm, $corridorFilter, $routingMode);
        $defaultBatchId = $this->latestArmBatchId(AdaptiveMaxArm::Default, $corridorFilter, $routingMode);
        if ($sartsmBatchId === null || $defaultBatchId === null) {
            return null;
        }

        $fixedRuns = $this->sheddingRuns($this->latestBatchIds->for($corridorFilter, $routingMode), ControllerMode::Fixed, null);

        return [
            'batchIds' => ['sartsm' => $sartsmBatchId, 'default' => $defaultBatchId],
            'arms' => [
                'fixed' => $this->series($fixedRuns),
                'default' => $this->series($this->sheddingRuns(collect([$defaultBatchId]), ControllerMode::Adaptive, self::SENSOR)),
                'sartsm' => $this->series($this->sheddingRuns(collect([$sartsmBatchId]), ControllerMode::Adaptive, self::SENSOR)),
            ],
        ];
    }

    private function latestArmBatchId(AdaptiveMaxArm $arm, ?string $corridorFilter, RoutingMode $routingMode): ?string
    {
        return SimulationRun::query()
            ->where('batch_kind', BatchKind::Sensitivity->value)
            ->where('routing_mode', $routingMode->value)
            ->where('raw_config_json->tag', $arm->value)
            ->when($corridorFilter, fn (Builder $query) => $query->where('corridor_config', $corridorFilter))
            ->latest('id')
            ->value('batch_id');
    }

    /**
     * @param  Collection<int, string>  $batchIds
     * @return Collection<int, SimulationRun>
     */
    private function sheddingRuns(Collection $batchIds, ControllerMode $controllerMode, ?string $sensorMode): Collection
    {
        return SimulationRun::query()
            ->whereIn('batch_id', $batchIds)
            ->where('controller_mode', $controllerMode->value)
            ->where('power_state', PowerState::RollingBlackout->value)
            ->when($sensorMode, fn (Builder $query) => $query->where('sensor_mode', $sensorMode))
            ->get(['diagnostics']);
    }

    /**
     * @param  Collection<int, SimulationRun>  $runs
     * @return array<string, mixed>
     */
    private function series(Collection $runs): array
    {
        $firstDiagnostics = $runs->first()?->diagnostics ?? [];

        return [
            'n' => $runs->count(),
            'waitBinS' => $firstDiagnostics['waitSeries']['binS'] ?? null,
            'wait' => $this->binMeans($runs->map(fn (SimulationRun $run): array => $run->diagnostics['waitSeries']['total'] ?? [])),
            'standingBinS' => $firstDiagnostics['zoneFlow']['binS'] ?? null,
            'zone2Standing' => $this->binMeans($runs->map(fn (SimulationRun $run): array => $run->diagnostics['zoneFlow']['standing'][self::ZONE] ?? [])),
        ];
    }

    /**
     * Per bin, the mean over the runs that have a value there - null where none does.
     *
     * @param  Collection<int, array<int, float|int|null>>  $seriesPerRun
     * @return array<int, float|null>
     */
    private function binMeans(Collection $seriesPerRun): array
    {
        $binCount = $seriesPerRun->map(fn (array $series): int => count($series))->max() ?? 0;
        if ($binCount === 0) {
            return [];
        }

        return collect(range(0, $binCount - 1))
            ->map(function (int $bin) use ($seriesPerRun): ?float {
                $values = $seriesPerRun->map(fn (array $series): mixed => $series[$bin] ?? null)->filter(fn (mixed $value): bool => is_numeric($value));

                return $values->isEmpty() ? null : round((float) $values->avg(), 2);
            })
            ->all();
    }
}
