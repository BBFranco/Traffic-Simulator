<?php

namespace App\Http\Controllers;

use App\Http\Requests\UpdateCorridorRoutingTiersRequest;
use App\Support\UserCorridorLayouts;
use Illuminate\Http\JsonResponse;

/** The Road Editor's Destinations: block tiers, added and removed blocks, saved into the user's own layout ("Revert to original" puts them back). */
class CorridorRoutingTierController extends Controller
{
    public function update(UpdateCorridorRoutingTiersRequest $request, string $corridor, UserCorridorLayouts $layouts): JsonResponse
    {
        $layout = $layouts->findOrFail($request->user(), $corridor);
        $layouts->updateRoutingTiers($layout, $request->validated('tiers', []), $request->validated('add', []), $request->validated('remove', []));

        return response()->json(['hasEdits' => $layout->hasEdits()]);
    }
}
