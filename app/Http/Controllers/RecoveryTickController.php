<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreRecoveryTicksRequest;
use App\Models\SimulationRunRecoveryTick;
use Illuminate\Http\JsonResponse;

/**
 * Where the "Recovery after a power cut" chart's per-tick series lands
 * (see SimulationRunRecoveryTick's docblock). Posted once per condition -
 * not batched like simulation-runs.store(), since only one representative
 * run per (controller_mode, sensor_mode) is ever kept.
 */
class RecoveryTickController extends Controller
{
    public function store(StoreRecoveryTicksRequest $request): JsonResponse
    {
        $controllerMode = $request->validated('controller_mode');
        $sensorMode = $request->validated('sensor_mode');

        SimulationRunRecoveryTick::query()
            ->where('controller_mode', $controllerMode)
            ->where('sensor_mode', $sensorMode)
            ->delete();

        $now = now();
        $rows = collect($request->validated('ticks'))->map(fn (array $tick) => [
            'controller_mode' => $controllerMode,
            'sensor_mode' => $sensorMode,
            'tick' => $tick['tick'],
            'seconds' => $tick['seconds'],
            'throughput_per_min' => $tick['throughput_per_min'],
            'throughput_per_min_arterial' => $tick['throughput_per_min_arterial'],
            'throughput_per_min_side_street' => $tick['throughput_per_min_side_street'],
            'avg_wait_time' => $tick['avg_wait_time'],
            'avg_wait_time_arterial' => $tick['avg_wait_time_arterial'],
            'avg_wait_time_side_street' => $tick['avg_wait_time_side_street'],
            'power_event_seconds' => $request->validated('power_event_seconds'),
            'power_outage_end_seconds' => $request->validated('power_outage_end_seconds'),
            'created_at' => $now,
        ]);

        SimulationRunRecoveryTick::query()->insert($rows->all());

        return response()->json(['inserted' => $rows->count()], 201);
    }
}
