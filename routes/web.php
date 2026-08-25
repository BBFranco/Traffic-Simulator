<?php

use App\Http\Controllers\BuilderController;
use App\Http\Controllers\ProfileController;
use App\Http\Controllers\ResultsController;
use App\Http\Controllers\SimulationRunController;
use App\Http\Controllers\SimulatorController;
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

    // Layout configs from `corridors/*.json`, fetched by the scenario picker.
    Route::get('/corridors/{corridor}', [SimulatorController::class, 'corridor'])
        ->where('corridor', '[A-Za-z0-9_-]+')
        ->name('corridors.show');

    Route::get('/builder', [BuilderController::class, 'index'])->name('builder');

    Route::get('/results', [ResultsController::class, 'index'])->name('results');
    // JSON refresh for the batch-run button (build step 17) - re-render charts
    // in place after a batch completes, no full page reload.
    Route::get('/results/data', [ResultsController::class, 'data'])->name('results.data');

    // Batch-run summaries land here (build step 16) - posted by the headless
    // batch runner and by the /results page's batch-run button (build step 17).
    Route::post('/api/simulation-runs', [SimulationRunController::class, 'store'])
        ->name('simulation-runs.store');

    Route::get('/profile', [ProfileController::class, 'edit'])->name('profile.edit');
    Route::patch('/profile', [ProfileController::class, 'update'])->name('profile.update');
    Route::delete('/profile', [ProfileController::class, 'destroy'])->name('profile.destroy');
});

require __DIR__.'/auth.php';
