<?php

namespace App\Http\Controllers;

use App\Enums\RoutingMode;
use App\Support\AppendixRuns;
use App\Support\LatestBatchIds;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** Every run of the batches the Results page shows, one plain row each - the report's appendix computes from them. */
class ResultsAppendixRunsController extends Controller
{
    public function __invoke(Request $request, LatestBatchIds $latestBatchIds, AppendixRuns $appendixRuns): JsonResponse
    {
        $routingMode = RoutingMode::tryFrom((string) $request->query('routing')) ?? RoutingMode::Random;
        $batchIds = $latestBatchIds->for($request->query('corridor'), $routingMode);

        return response()->json($appendixRuns->forBatches($batchIds));
    }
}
