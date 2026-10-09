<?php

namespace App\Http\Controllers;

use App\Enums\BatchKind;
use App\Enums\RoutingMode;
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
     * One representative run per (controller_mode, power_state, sensor_mode) condition from
     * the corridor's latest main batch in the requested routing mode (`?routing=`, random by
     * default) - feeds the Simulator page's "replay a batch run" picker. The lowest `id` in each
     * group is as good a representative as any other rep of the same condition (same
     * distribution, different seed), so this doesn't need to be configurable.
     *
     * `raw_config_json` carries everything (seed, warmup/outage/duration ticks) a replay needs
     * to reproduce that run's exact timeline - see runHeadless.js's buildSummary().
     * `fixed_twin` is the same batch's fixed-time run on the same seed and power state, for the
     * live panel's "vs fixed-time" delta - null when the batch has none.
     */
    public function sampleRuns(Request $request): JsonResponse
    {
        $corridor = $request->query('corridor');
        $routingMode = RoutingMode::tryFrom((string) $request->query('routing')) ?? RoutingMode::Random;

        $latestBatchId = SimulationRun::query()
            ->where('routing_mode', $routingMode->value)
            ->where('batch_kind', BatchKind::Main->value)
            ->when($corridor, fn (Builder $query) => $query->where('corridor_config', $corridor))
            ->latest('id')
            ->value('batch_id');

        $ids = SimulationRun::query()
            ->where('batch_id', $latestBatchId)
            ->selectRaw('MIN(id) as id')
            ->groupBy('controller_mode', 'power_state', 'sensor_mode')
            ->pluck('id');

        $runs = SimulationRun::query()
            ->whereIn('id', $ids)
            ->get(['id', 'seed', 'controller_mode', 'sensor_mode', 'power_state', 'routing_mode', 'corridor_config', 'raw_config_json']);

        $fixedTwins = SimulationRun::query()
            ->where('batch_id', $latestBatchId)
            ->where('controller_mode', 'fixed')
            ->whereIn('seed', $runs->pluck('seed'))
            ->get(['seed', 'power_state', 'avg_wait_time', 'throughput_per_min'])
            ->keyBy(fn (SimulationRun $run): string => "{$run->seed}|{$run->power_state}");

        $runs->each(fn (SimulationRun $run) => $run->setAttribute(
            'fixed_twin',
            $fixedTwins->get("{$run->seed}|{$run->power_state}")?->only(['avg_wait_time', 'throughput_per_min'])
        ));

        return response()->json(['runs' => $runs]);
    }
}
