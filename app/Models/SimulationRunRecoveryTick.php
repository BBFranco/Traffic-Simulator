<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;

/**
 * One (tick, throughput_per_min, avg_wait_time) sample of a load-shedding
 * condition's recovery curve, averaged across every rep of that
 * (controller_mode, sensor_mode) condition - see recoveryTickPayload.js's
 * accumulateRecoveryTicks()/finalizeRecoveryTickPayload() and the migration's
 * docblock for why this exists alongside `simulation_runs`.
 */
#[Fillable([
    'controller_mode',
    'sensor_mode',
    'tick',
    'seconds',
    'throughput_per_min',
    'throughput_per_min_arterial',
    'throughput_per_min_side_street',
    'avg_wait_time',
    'avg_wait_time_arterial',
    'avg_wait_time_side_street',
    'power_event_seconds',
    'power_outage_end_seconds',
])]
class SimulationRunRecoveryTick extends Model
{
    /** Immutable sample row - only created_at exists on the table, no updated_at to maintain. */
    public $timestamps = false;

    protected static function booted(): void
    {
        static::creating(function (self $tick) {
            $tick->created_at ??= now();
        });
    }
}
