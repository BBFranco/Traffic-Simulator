<?php

namespace App\Http\Controllers;

use App\Support\CorridorRepository;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/** One shared corridor template from `corridors/*.json` - what the Results and Traffic Counter pages draw, matching the batch dataset. */
class CorridorTemplateController extends Controller
{
    public function __invoke(CorridorRepository $templates, string $corridor): JsonResponse
    {
        $config = $templates->find($corridor) ?? throw new NotFoundHttpException("Unknown corridor template [{$corridor}].");

        return response()->json($config);
    }
}
