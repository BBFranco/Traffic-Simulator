<?php

namespace App\Http\Controllers;

use App\Http\Requests\UpdateCorridorSlipLanesRequest;
use App\Support\UserCorridorLayouts;
use Illuminate\Http\JsonResponse;

/** The Road Editor's slip-lane toggle: the whole set of slip lanes, drawn in the browser, saved into the user's own layout ("Revert to original" puts them back). */
class CorridorSlipLaneController extends Controller
{
    public function update(UpdateCorridorSlipLanesRequest $request, string $corridor, UserCorridorLayouts $layouts): JsonResponse
    {
        $layout = $layouts->findOrFail($request->user(), $corridor);
        $layouts->updateSlipLanes($layout, $request->validated('slipLanes'), $request->validated('connectors'), $request->validated('joins'));

        return response()->json(['hasEdits' => $layout->hasEdits()]);
    }
}
