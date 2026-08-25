<?php

namespace App\Http\Controllers;

use Illuminate\View\View;

/**
 * Serves the /builder page - a from-scratch road network editor.
 *
 * Phase 1 shell: the whole tool (road placement, lane counts, connection
 * points, junction detection) lives client-side in builder.js. There is
 * nothing to load or persist from the server yet, so this controller only
 * renders the page.
 */
class BuilderController extends Controller
{
    public function index(): View
    {
        return view('builder');
    }
}
