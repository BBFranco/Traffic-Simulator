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
            'created_at' => now(),
        ]);

        SimulationRun::query()->insert($rows->all());

        return response()->json(['inserted' => $rows->count()], 201);
    }
}
