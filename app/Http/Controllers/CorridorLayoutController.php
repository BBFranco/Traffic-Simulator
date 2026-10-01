<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreCorridorLayoutRequest;
use App\Support\UserCorridorLayouts;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The Road Editor's Import and Delete for the user's own road layouts. Import
 * answers with the new layout's picker descriptor so the page can switch to it.
 */
class CorridorLayoutController extends Controller
{
    public function __construct(private readonly UserCorridorLayouts $layouts) {}

    public function store(StoreCorridorLayoutRequest $request): JsonResponse
    {
        $layout = $this->layouts->import($request->user(), $request->layoutConfig(), $request->file('layout')->getClientOriginalName());
        $descriptor = collect($this->layouts->index($request->user()))->firstWhere('id', $layout->slug);

        return response()->json(['layout' => $descriptor], 201);
    }

    public function destroy(Request $request, string $corridor): JsonResponse
    {
        $layout = $this->layouts->findOrFail($request->user(), $corridor);

        if (! $this->layouts->delete($layout)) {
            return response()->json(['message' => 'This is your only layout - import another before deleting it.'], 409);
        }

        return response()->json(['defaultCorridorId' => $this->layouts->defaultSlug($request->user())]);
    }
}
