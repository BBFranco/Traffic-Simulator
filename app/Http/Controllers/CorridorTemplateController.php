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
        $raw = $templates->raw($corridor) ?? throw new NotFoundHttpException("Unknown corridor template [{$corridor}].");

        // As objects, so an empty `{}` stays `{}` - decoded as arrays it came back `[]` and read as drift from the saved layout.
        return response()->json(json_decode($raw, false, 512, JSON_THROW_ON_ERROR));
    }
}
