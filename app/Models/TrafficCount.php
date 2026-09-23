<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * One uploaded traffic-count video and its detection/flow-fit results (Traffic
 * Counter spec §3). Mutated in place by ProcessTrafficCount as it moves
 * pending -> processing -> done/failed, unlike SimulationRun's write-once rows.
 */
#[Fillable([
    'corridor_config',
    'street',
    'label',
    'video_path',
    'annotated_video_path',
    'line_coords_json',
    'status',
    'error_message',
    'observation_duration_seconds',
    'frames_processed',
    'vehicles_detected',
    'total_vehicles',
    'cars_count',
    'trucks_count',
    'unclassified_count',
    'mean_flow',
    'min_flow',
    'max_flow',
    'std_dev',
    'peak_5min_flow',
    'fitted_mid',
    'fitted_amplitude',
    'fitted_r_squared',
    'assumed_period_seconds',
])]
class TrafficCount extends Model
{
    protected function casts(): array
    {
        return [
            'line_coords_json' => 'array',
        ];
    }

    /** @return HasMany<TrafficCountBucket, $this> */
    public function buckets(): HasMany
    {
        return $this->hasMany(TrafficCountBucket::class);
    }

    /** Status badge colouring for the recent-counts list. */
    protected function statusBadgeClasses(): Attribute
    {
        return Attribute::get(fn () => match ($this->status) {
            'done' => 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
            'failed' => 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300',
            default => 'bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
        });
    }
}
