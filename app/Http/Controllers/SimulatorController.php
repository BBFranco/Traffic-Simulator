<?php

namespace App\Http\Controllers;

use App\Support\CorridorRepository;
use Illuminate\Http\JsonResponse;
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
}
