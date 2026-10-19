<?php

namespace App\Http\Controllers;

use App\Support\UserCorridorLayouts;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** Road Editor's "Use for batches": overwrites the shared template file (what batches run on) with the user's saved layout of the same id. */
class CorridorTemplatePublishController extends Controller
{
    public function __invoke(Request $request, UserCorridorLayouts $layouts, string $corridor): JsonResponse
    {
        $layout = $layouts->findOrFail($request->user(), $corridor);

        if (! $layouts->publishToTemplate($layout)) {
            return response()->json(['message' => "There is no template corridors/{$corridor}.json to overwrite."], 404);
        }

        return response()->json(['published' => true]);
    }
}
