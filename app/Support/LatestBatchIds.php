<?php

namespace App\Support;

use App\Enums\BatchKind;
use App\Enums\RoutingMode;
use App\Models\SimulationRun;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Collection;

/**
 * Each corridor's most recent main batch - older batches were produced by earlier engine versions, so pooling them
 * would blend incomparable runs. What the Results page and its report read.
 */
class LatestBatchIds
{
    /** @return Collection<int, string> */
    public function for(?string $corridorFilter, RoutingMode $routingMode): Collection
    {
        $latestRunIds = SimulationRun::query()
            ->where('routing_mode', $routingMode->value)
            ->where('batch_kind', BatchKind::Main->value)
            ->when($corridorFilter, fn (Builder $query) => $query->where('corridor_config', $corridorFilter))
            ->selectRaw('max(id)')
            ->groupBy('corridor_config');

        return SimulationRun::query()->whereIn('id', $latestRunIds)->pluck('batch_id');
    }
}
