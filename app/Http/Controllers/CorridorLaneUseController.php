<?php

namespace App\Http\Controllers;

use App\Http\Requests\UpdateCorridorLaneUseRequest;
use App\Support\UserCorridorLayouts;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The Road Editor's lane arrows and turn lanes: saving writes them into the
 * user's own layout, and destroying the edits puts the layout back as it was imported.
 */
class CorridorLaneUseController extends Controller
{
    public function __construct(private readonly UserCorridorLayouts $layouts) {}

    public function update(UpdateCorridorLaneUseRequest $request, string $corridor): JsonResponse
    {
        $layout = $this->layouts->findOrFail($request->user(), $corridor);
        $this->layouts->updateLaneUse($layout, $request->validated('approaches'));

        return response()->json(['hasEdits' => $layout->hasEdits()]);
    }

    public function destroy(Request $request, string $corridor): JsonResponse
    {
        $layout = $this->layouts->findOrFail($request->user(), $corridor);

        if (! $this->layouts->revert($layout)) {
            return response()->json(['message' => 'No saved edits to revert - this layout is already as it was imported.'], 409);
        }

        return response()->json(['hasEdits' => false]);
    }
}
