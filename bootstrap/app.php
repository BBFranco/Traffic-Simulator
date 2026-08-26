<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // These two endpoints exist specifically for the headless CLI batch runner
        // (batch/runBatch.mjs, see routes/web.php's comment on them) - a plain Node
        // fetch() has no browser session or CSRF token to present, so both would
        // otherwise 419/401 on every request from the CLI.
        $middleware->validateCsrfTokens(except: [
            'api/simulation-runs',
            'api/recovery-ticks',
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
