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
            'runs.*.throughput_per_min' => ['required', 'numeric', 'min:0'],
            'runs.*.pct_cleared_without_stop' => ['required', 'numeric', 'between:0,100'],
            'runs.*.time_to_recovery_seconds' => ['nullable', 'numeric', 'min:0'],
            'runs.*.raw_config_json' => ['required', 'array'],
        ];
    }
}
