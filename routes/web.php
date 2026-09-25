<?php

use App\Http\Controllers\CorridorLaneUseController;
use App\Http\Controllers\CorridorLayoutController;
use App\Http\Controllers\CorridorTemplateController;
use App\Http\Controllers\ProfileController;
use App\Http\Controllers\RecoveryTickController;
use App\Http\Controllers\ResultsController;
use App\Http\Controllers\RoadEditorController;
use App\Http\Controllers\SimulationRunController;
use App\Http\Controllers\SimulatorController;
use App\Http\Controllers\TrafficCounterController;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return Auth::check()
        ? redirect()->route('simulator')
        : view('welcome');
})->name('home');

/*
 * Breeze redirects here after login/registration. The spec wants the simulator
 * to be the landing page, so `dashboard` stays as a named route (Breeze's
 * RouteServiceProvider constants and the auth controllers reference it) and just
 * forwards on.
 */
Route::get('/dashboard', fn () => redirect()->route('simulator'))
    ->middleware(['auth', 'verified'])
    ->name('dashboard');

Route::middleware('auth')->group(function () {
    Route::get('/simulator', [SimulatorController::class, 'index'])->name('simulator');

    // The user's own road layouts: fetched by the Simulator/Road Editor pickers, imported and deleted in the Road Editor.
    Route::get('/corridors/{corridor}', [SimulatorController::class, 'corridor'])
        ->where('corridor', '[A-Za-z0-9_-]+')
        ->name('corridors.show');
    Route::post('/corridors', [CorridorLayoutController::class, 'store'])->name('corridors.store');
    Route::delete('/corridors/{corridor}', [CorridorLayoutController::class, 'destroy'])
        ->where('corridor', '[A-Za-z0-9_-]+')
        ->name('corridors.destroy');

    // The shared read-only templates in `corridors/*.json` - the batch dataset's layouts, drawn by Results and Traffic Counter.
    Route::get('/corridor-templates/{corridor}', CorridorTemplateController::class)
        ->where('corridor', '[A-Za-z0-9_-]+')
        ->name('corridor-templates.show');

    // Lane-arrow editor: save edits into the user's layout, or put it back as it was imported.
    Route::put('/corridors/{corridor}/lane-use', [CorridorLaneUseController::class, 'update'])
        ->where('corridor', '[A-Za-z0-9_-]+')
        ->name('corridors.lane-use.update');
    Route::delete('/corridors/{corridor}/lane-use', [CorridorLaneUseController::class, 'destroy'])
        ->where('corridor', '[A-Za-z0-9_-]+')
        ->name('corridors.lane-use.destroy');

    // One representative batch-dataset run per condition, for the "replay a batch run" picker.
    Route::get('/simulator/sample-runs', [SimulatorController::class, 'sampleRuns'])->name('simulator.sample-runs');

    Route::get('/results', [ResultsController::class, 'index'])->name('results');
    // JSON refresh for the batch-run button (build step 17) - re-render charts
    // in place after a batch completes, no full page reload.
    Route::get('/results/data', [ResultsController::class, 'data'])->name('results.data');

    // One intersection at a time with test traffic - click the lane arrows, save them into the corridor file.
    Route::get('/road-editor', [RoadEditorController::class, 'index'])->name('road-editor');

    // Traffic Counter tab (spec §2) - unlike /api/simulation-runs and
    // /api/recovery-ticks below, these stay inside 'auth' + CSRF: they're driven
    // by a logged-in user's browser session uploading a video, not a headless CLI.
    Route::get('/traffic-counter', [TrafficCounterController::class, 'index'])->name('traffic-counter');
    Route::post('/api/traffic-counts', [TrafficCounterController::class, 'store'])->name('traffic-counts.store');
    Route::get('/api/traffic-counts', [TrafficCounterController::class, 'list'])->name('traffic-counts.list');
    Route::get('/api/traffic-counts/{trafficCount}', [TrafficCounterController::class, 'status'])->name('traffic-counts.status');
    Route::get('/api/traffic-counts/{trafficCount}/data', [TrafficCounterController::class, 'data'])->name('traffic-counts.data');
    Route::get('/api/traffic-counts/{trafficCount}/video', [TrafficCounterController::class, 'video'])->name('traffic-counts.video');
    Route::delete('/api/traffic-counts/{trafficCount}', [TrafficCounterController::class, 'destroy'])->name('traffic-counts.destroy');

    Route::get('/profile', [ProfileController::class, 'edit'])->name('profile.edit');
    Route::patch('/profile', [ProfileController::class, 'update'])->name('profile.update');
    Route::delete('/profile', [ProfileController::class, 'destroy'])->name('profile.destroy');
});

/*
 * Deliberately OUTSIDE the 'auth' group - batch/runBatch.mjs's headless CLI batch runner
 * posts here directly with a plain Node fetch(), which has no browser session to
 * authenticate with. The browser's own /results batch-run button still hits these same
 * routes (just with a session it happens to already have). Also exempted from CSRF
 * verification (bootstrap/app.php) for the same reason. This is a local single-user
 * dissertation tool, not a multi-tenant app - these two endpoints only ever accept
 * simulation-run summary data, nothing sensitive.
 */
// Batch-run summaries land here (build step 16) - posted by the headless
// batch runner and by the /results page's batch-run button (build step 17).
Route::post('/api/simulation-runs', [SimulationRunController::class, 'store'])
    ->name('simulation-runs.store');

// The "Recovery after a power cut" chart's per-tick series (build step 22b) - posted
// once per representative condition, replacing that condition's prior series.
Route::post('/api/recovery-ticks', [RecoveryTickController::class, 'store'])
    ->name('recovery-ticks.store');

require __DIR__.'/auth.php';
