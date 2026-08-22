<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;

/**
 * One completed batch run's summary metrics (build step 16). No
 * relationships, no separate metrics table - per-tick detail lives in the
 * headless runner's CSV export instead, per the Phase 2 spec's schema
 * rationale.
 */
#[Fillable([
    'seed',
    'controller_mode',
    'power_state',
    'sensor_mode',
    'corridor_config',
    'avg_wait_time',
    'throughput_per_min',
    'pct_cleared_without_stop',
    'time_to_recovery_seconds',
    'raw_config_json',
])]
class SimulationRun extends Model
{
    /** Immutable summary record - only created_at exists on the table, no updated_at to maintain. */
    public $timestamps = false;

    protected function casts(): array
    {
        return [
            'raw_config_json' => 'array',
            'created_at' => 'datetime',
        ];
    }

    protected static function booted(): void
    {
        static::creating(function (self $run) {
            $run->created_at ??= now();
        });
    }
}
