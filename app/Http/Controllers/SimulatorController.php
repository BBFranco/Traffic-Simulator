<?php

namespace App\Http\Controllers;

use App\Models\SimulationRun;
use App\Support\CorridorRepository;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Serves the simulator page and the corridor layout configs it draws.
 *
 * Laravel never runs the simulation - it hands the browser a layout config and
 * gets out of the way. There is no per-frame round trip, by design.
 */
class SimulatorController extends Controller
{
    public function __construct(private readonly CorridorRepository $corridors) {}

    public function index(): View
    {
        $available = $this->corridors->index();
        $defaultId = $this->corridors->defaultId();

        return view('simulator', [
            'corridors' => $available,
            'defaultCorridorId' => $defaultId,
            // Inlined so the first paint needs no round trip; the picker fetches
            // the others from the endpoint below.
            'defaultCorridor' => $defaultId ? $this->corridors->find($defaultId) : null,
        ]);
    }

    public function corridor(string $corridor): JsonResponse
    {
        $config = $this->corridors->find($corridor);

        if ($config === null) {
            throw new NotFoundHttpException("Unknown corridor config [{$corridor}].");
        }

        return response()->json($config);
    }

    /**
     * One representative run per (controller_mode, power_state, sensor_mode) condition from
     * the batch dataset - feeds the Simulator page's "replay a batch run" picker. The lowest
     * `id` in each group is as good a representative as any other rep of the same condition
     * (same distribution, different seed), so this doesn't need to be configurable.
     *
     * `raw_config_json` carries everything (seed, warmup/outage/duration ticks) a replay needs
     * to reproduce that run's exact timeline - see runHeadless.js's buildSummary().
     */
    public function sampleRuns(Request $request): JsonResponse
    {
        $corridor = $request->query('corridor');

        $ids = SimulationRun::query()
            ->when($corridor, fn ($query) => $query->where('corridor_config', $corridor))
            ->selectRaw('MIN(id) as id')
            ->groupBy('controller_mode', 'power_state', 'sensor_mode')
            ->pluck('id');

        $runs = SimulationRun::query()
            ->whereIn('id', $ids)
            ->get(['id', 'seed', 'controller_mode', 'sensor_mode', 'power_state', 'corridor_config', 'raw_config_json']);

        return response()->json(['runs' => $runs]);
    }
}
