<?php

namespace App\Http\Requests;

use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;

/**
 * One representative run's per-tick recovery series for a single
 * (controller_mode, sensor_mode) condition - see
 * SimulationRunRecoveryTick's docblock. RecoveryTickController::store()
 * replaces any existing series for that condition rather than appending.
 */
class StoreRecoveryTicksRequest extends FormRequest
{
    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'controller_mode' => ['required', 'in:fixed,adaptive,green_wave'],
            // Null (fixed and green-wave never vary by sensor) or one of the four real modes.
            'sensor_mode' => ['nullable', 'in:inductive_loop,radar,camera,magnetometer'],
            'power_event_seconds' => ['required', 'numeric', 'min:0'],
            'power_outage_end_seconds' => ['required', 'numeric', 'gt:power_event_seconds'],
            'ticks' => ['required', 'array', 'min:1'],
            'ticks.*.tick' => ['required', 'integer', 'min:0'],
            'ticks.*.seconds' => ['required', 'numeric', 'min:0'],
            'ticks.*.throughput_per_min' => ['required', 'numeric', 'min:0'],
            'ticks.*.throughput_per_min_arterial' => ['required', 'numeric', 'min:0'],
            'ticks.*.throughput_per_min_side_street' => ['required', 'numeric', 'min:0'],
            'ticks.*.avg_wait_time' => ['required', 'numeric', 'min:0'],
            'ticks.*.avg_wait_time_arterial' => ['required', 'numeric', 'min:0'],
            'ticks.*.avg_wait_time_side_street' => ['required', 'numeric', 'min:0'],
        ];
    }
}
