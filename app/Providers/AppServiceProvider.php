<?php

namespace App\Providers;

use App\View\Composers\RoadEditorComposer;
use App\View\Composers\SimulatorComposer;
use App\View\Composers\TrafficCounterComposer;
use Illuminate\Support\Facades\View;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        View::composer('simulator', SimulatorComposer::class);
        View::composer('road-editor', RoadEditorComposer::class);
        View::composer('traffic-counter', TrafficCounterComposer::class);
    }
}
