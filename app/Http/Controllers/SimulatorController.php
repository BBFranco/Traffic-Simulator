<?php

namespace App\Http\Controllers;

use App\Enums\BatchKind;
use App\Models\SimulationRun;
use App\Support\UserCorridorLayouts;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Serves the simulator page and the user's own road layouts it draws.
 *
 * Laravel never runs the simulation - it hands the browser a layout config and
 * gets out of the way. There is no per-frame round trip, by design.
 */
class SimulatorController extends Controller
{
    public function __construct(private readonly UserCorridorLayouts $layouts) {}

    public function index(Request $request): View
    {
        $available = $this->layouts->index($request->user());
        $defaultId = $this->layouts->defaultSlug($request->user());

        return view('simulator', [
            'corridors' => $available,
            'defaultCorridorId' => $defaultId,
            // Inlined so the first paint needs no round trip; the picker fetches
            // the others from the endpoint below.
            'defaultCorridor' => $defaultId ? $this->layouts->findOrFail($request->user(), $defaultId)->config : null,
        ]);
    }

    public function corridor(Request $request, string $corridor): JsonResponse
    {
        return response()->json($this->layouts->findOrFail($request->user(), $corridor)->config);
    }

    /**
     * Every run of the corridor's latest main batch, whatever its routing mode - feeds the Simulator
     * page's "replay a batch run" picker, which offers each (controller_mode, sensor_mode,
     * power_state) condition with the seeds it ran on. Not tied to the page's routing toggle: the
     * random-turn batches are older short-protocol ones. Kept to the picker's columns; replayRun()
     * serves the one run actually played.
     */
    public function sampleRuns(Request $request): JsonResponse
    {
        $corridor = $request->query('corridor');

        $latestBatchId = SimulationRun::query()
            ->where('batch_kind', BatchKind::Main->value)
            ->when($corridor, fn (Builder $query) => $query->where('corridor_config', $corridor))
            ->latest('id')
            ->value('batch_id');

        $runs = SimulationRun::query()
            ->where('batch_id', $latestBatchId)
            ->orderBy('id')
            ->get(['id', 'seed', 'controller_mode', 'sensor_mode', 'power_state']);

        return response()->json(['runs' => $runs]);
    }

    /**
     * One batch run, ready to replay. `raw_config_json` carries everything (seed, warmup/outage/
     * duration ticks) a replay needs to reproduce that run's exact timeline - see runHeadless.js's
     * buildSummary(). `fixed_twin` is the same batch's fixed-time run on the same seed and power
     * state, for the live panel's "vs fixed-time" delta - null when the batch has none.
     */
    public function replayRun(SimulationRun $simulationRun): JsonResponse
    {
        $fixedTwin = SimulationRun::query()
            ->where('batch_id', $simulationRun->batch_id)
            ->where('controller_mode', 'fixed')
            ->where('seed', $simulationRun->seed)
            ->where('power_state', $simulationRun->power_state->value)
            ->first(['avg_wait_time', 'throughput_per_min']);

        return response()->json([
            ...$simulationRun->only(['id', 'seed', 'controller_mode', 'sensor_mode', 'power_state', 'routing_mode', 'corridor_config', 'raw_config_json']),
            'fixed_twin' => $fixedTwin?->only(['avg_wait_time', 'throughput_per_min']),
        ]);
    }
}
