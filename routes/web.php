<?php

use App\Http\Controllers\ProfileController;
use App\Http\Controllers\ResultsController;
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

    Route::get('/results', [ResultsController::class, 'index'])->name('results');

    Route::get('/profile', [ProfileController::class, 'edit'])->name('profile.edit');
    Route::patch('/profile', [ProfileController::class, 'update'])->name('profile.update');
    Route::delete('/profile', [ProfileController::class, 'destroy'])->name('profile.destroy');
});

require __DIR__.'/auth.php';
