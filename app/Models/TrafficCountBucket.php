<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One bucketed time window of a TrafficCount's observed flow (Traffic Counter
 * spec §3). Written once by ProcessTrafficCount, immutable afterwards - same
 * shape as SimulationRunRecoveryTick's relationship to SimulationRun.
 */
#[Fillable(['traffic_count_id', 'bucket_start_seconds', 'vehicles_per_min', 'cars', 'trucks'])]
class TrafficCountBucket extends Model
{
    public $timestamps = false;

    protected static function booted(): void
    {
        static::creating(function (self $bucket) {
            $bucket->created_at ??= now();
        });
    }

    /** @return BelongsTo<TrafficCount, $this> */
    public function trafficCount(): BelongsTo
    {
        return $this->belongsTo(TrafficCount::class);
    }
}
