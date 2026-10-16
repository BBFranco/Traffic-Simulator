<?php

namespace App\Http\Controllers;

use App\Models\SimulationRun;
use Illuminate\Http\JsonResponse;

/**
 * What the latest main batch has stored so far, for the /results Resume button: its settings and every run it holds.
 * Whether it is finished is the page's call - only the experimental matrix (JS) knows how many runs a batch has.
 */
class LatestBatchProgressController extends Controller
{
    public function __invoke(): JsonResponse
    {
        $latest = SimulationRun::query()->where('batch_kind', 'main')->latest('id')->first();
        if ($latest === null) {
            return response()->json(null);
        }

        $runs = SimulationRun::query()
            ->toBase()
            ->where('batch_id', $latest->batch_id)
            ->get(['seed', 'controller_mode', 'sensor_mode', 'power_state'])
            ->map(fn (object $run): array => [
                'seed' => (int) $run->seed,
                'controllerMode' => $run->controller_mode,
                'sensorMode' => $run->sensor_mode,
                'powerState' => $run->power_state,
            ]);
        $config = $latest->raw_config_json ?? [];

        return response()->json([
            'batchId' => $latest->batch_id,
            'batchStartedAt' => $latest->batch_started_at?->toIso8601String(),
            'lastStoredAt' => $latest->created_at?->toIso8601String(),
            'corridorConfig' => $latest->corridor_config,
            'routingMode' => $latest->routing_mode,
            'warmup' => [
                'warmupTicks' => $latest->warmup_ticks,
                'stationary' => $latest->warmup_stationary,
                'drifting' => $latest->warmup_drifting,
                'settle' => $config['warmupSettle'] ?? null,
            ],
            'demandScale' => $config['demandScale'] ?? 1,
            'demandOverrides' => $config['demandOverrides'] ?? null,
            'build' => $config['build'] ?? null,
            'runs' => $runs->values(),
        ]);
    }
}
