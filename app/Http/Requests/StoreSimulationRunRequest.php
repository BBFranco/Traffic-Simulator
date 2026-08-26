<?php

namespace App\Http\Requests;

use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Accepts a batch of run summaries in one request - `{ "runs": [ {...}, ... ] }`
 * - rather than one row per HTTP round-trip. The batch-run button (build step
 * 17) posts every 20-30 completed runs or once at the end; a single run is
 * just the degenerate case of a batch with one element, so there is only one
 * request shape to validate.
 */
class StoreSimulationRunRequest extends FormRequest
{
    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'runs' => ['required', 'array', 'min:1'],
            'runs.*.seed' => ['required', 'integer'],
            'runs.*.controller_mode' => ['required', 'in:fixed,adaptive,green_wave'],
            'runs.*.power_state' => ['required', 'in:normal,load_shedding'],
            // Null (fixed-time never reads sensors) or one of the four real modes -
            // 'none' is a UI-only option and never a valid stored run.
            'runs.*.sensor_mode' => ['nullable', 'in:inductive_loop,radar,camera,magnetometer'],
            'runs.*.corridor_config' => ['required', 'string', 'max:255'],
            'runs.*.avg_wait_time' => ['required', 'numeric', 'min:0'],
            'runs.*.avg_wait_time_arterial' => ['required', 'numeric', 'min:0'],
            'runs.*.avg_wait_time_side_street' => ['required', 'numeric', 'min:0'],
            'runs.*.throughput_per_min' => ['required', 'numeric', 'min:0'],
            'runs.*.throughput_per_min_arterial' => ['required', 'numeric', 'min:0'],
            'runs.*.throughput_per_min_side_street' => ['required', 'numeric', 'min:0'],
            'runs.*.pct_cleared_without_stop' => ['required', 'numeric', 'between:0,100'],
            'runs.*.pct_cleared_without_stop_arterial' => ['required', 'numeric', 'between:0,100'],
            'runs.*.pct_cleared_without_stop_side_street' => ['required', 'numeric', 'between:0,100'],
            'runs.*.time_to_recovery_seconds' => ['nullable', 'numeric', 'min:0'],
            'runs.*.time_to_recovery_seconds_arterial' => ['nullable', 'numeric', 'min:0'],
            'runs.*.time_to_recovery_seconds_side_street' => ['nullable', 'numeric', 'min:0'],
            // Total scope only - null on a normal-power run (nothing to segment) or on the
            // "during outage" segment before it has any clears yet.
            'runs.*.avg_wait_time_pre_outage' => ['nullable', 'numeric', 'min:0'],
            'runs.*.avg_wait_time_during_outage' => ['nullable', 'numeric', 'min:0'],
            'runs.*.avg_wait_time_post_recovery' => ['nullable', 'numeric', 'min:0'],
            'runs.*.throughput_per_min_pre_outage' => ['nullable', 'numeric', 'min:0'],
            'runs.*.throughput_per_min_during_outage' => ['nullable', 'numeric', 'min:0'],
            'runs.*.throughput_per_min_post_recovery' => ['nullable', 'numeric', 'min:0'],
            'runs.*.median_wait_time' => ['nullable', 'numeric', 'min:0'],
            'runs.*.p95_wait_time' => ['nullable', 'numeric', 'min:0'],
            'runs.*.max_wait_time' => ['nullable', 'numeric', 'min:0'],
            'runs.*.raw_config_json' => ['required', 'array'],
        ];
    }
}
