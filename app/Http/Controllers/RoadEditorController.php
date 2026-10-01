<?php

namespace App\Http\Controllers;

use App\Support\UserCorridorLayouts;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * The Road editor tab: the user's own road layouts - import new ones, view one
 * whole, or one intersection at a time with test traffic, where the lane
 * arrows and turn lanes can be edited and saved (CorridorLaneUseController).
 */
class RoadEditorController extends Controller
{
    public function index(Request $request, UserCorridorLayouts $layouts): View
    {
        return view('road-editor', [
            'corridors' => $layouts->index($request->user()),
            'defaultCorridorId' => $layouts->defaultSlug($request->user()),
        ]);
    }
}
