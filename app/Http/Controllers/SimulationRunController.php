<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreSimulationRunRequest;
use App\Models\SimulationRun;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Carbon;

/**
 * Where batch-run summaries land in the database (build step 16). The
 * simulation itself never touches MySQL/SQLite directly - it is a JS process,
 * headless or in-browser, that POSTs one run's summary JSON per completed run
 * (build step 13/17) here, and this is the one place the schema can change.
 */
class SimulationRunController extends Controller
{
    public function store(StoreSimulationRunRequest $request): JsonResponse
    {
        $rows = collect($request->validated('runs'))->map(fn (array $run) => [
            ...$run,
            // Sent as an ISO-8601 instant; stored in UTC like created_at.
            'batch_started_at' => isset($run['batch_started_at']) ? Carbon::parse($run['batch_started_at'])->utc()->format('Y-m-d H:i:s') : null,
            'raw_config_json' => json_encode($run['raw_config_json']),
            'routing_stats' => isset($run['routing_stats']) ? json_encode($run['routing_stats']) : null,
            'coordination_stats' => isset($run['coordination_stats']) ? json_encode($run['coordination_stats']) : null,
            'road_waits' => isset($run['road_waits']) ? json_encode($run['road_waits']) : null,
            'zone_stats' => isset($run['zone_stats']) ? json_encode($run['zone_stats']) : null,
            'warmup_drifting' => isset($run['warmup_drifting']) ? json_encode($run['warmup_drifting']) : null,
            'diagnostics' => isset($run['diagnostics']) ? json_encode($run['diagnostics']) : null,
            'created_at' => now(),
        ]);

        // A resumed batch (runBatch.mjs --resume) may re-post a chunk the server stored but never acknowledged.
        $storedKeys = SimulationRun::query()
            ->toBase()
            ->whereIn('batch_id', $rows->pluck('batch_id')->unique())
            ->get(['batch_id', 'seed', 'controller_mode', 'sensor_mode', 'power_state'])
            ->map(fn (object $run): string => $this->runKey((array) $run))
            ->flip();
        $newRows = $rows->reject(fn (array $run): bool => $storedKeys->has($this->runKey($run)));

        SimulationRun::query()->insert($newRows->values()->all());

        return response()->json(['inserted' => $newRows->count(), 'skipped' => $rows->count() - $newRows->count()], 201);
    }

    /** One run of a batch: its condition and seed. */
    private function runKey(array $run): string
    {
        return implode('|', [$run['batch_id'], $run['seed'], $run['controller_mode'], $run['sensor_mode'] ?? '', $run['power_state']]);
    }
}
