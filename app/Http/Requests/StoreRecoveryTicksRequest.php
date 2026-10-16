<?php

namespace App\Http\Requests;

use App\Enums\ControllerMode;
use App\Enums\PowerState;
use App\Enums\RoutingMode;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * One (already averaged-across-reps) per-tick recovery series for a single
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
            'controller_mode' => ['required', Rule::enum(ControllerMode::class)],
            // Null (fixed and green-wave never vary by sensor) or one of the four real modes.
            'sensor_mode' => ['nullable', 'in:inductive_loop,radar,camera,magnetometer'],
            'corridor_config' => ['required', 'string', 'max:255'],
            'routing_mode' => ['sometimes', Rule::enum(RoutingMode::class)],
            // An outage state only - a normal-power run has no recovery curve.
            'power_state' => ['sometimes', Rule::enum(PowerState::class)->only([PowerState::LoadShedding, PowerState::RollingBlackout])],
            'power_event_seconds' => ['required', 'numeric', 'min:0'],
            'power_outage_end_seconds' => ['required', 'numeric', 'gt:power_event_seconds'],
            'dark_windows' => ['nullable', 'array'],
            'dark_windows.*.zones' => ['nullable', 'array'],
            'dark_windows.*.zones.*' => ['integer', 'between:1,3'],
            'dark_windows.*.fromS' => ['required', 'numeric', 'min:0'],
            'dark_windows.*.toS' => ['required', 'numeric', 'gt:dark_windows.*.fromS'],
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
