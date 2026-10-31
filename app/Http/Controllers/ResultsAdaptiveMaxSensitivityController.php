<?php

namespace App\Http\Controllers;

use App\Enums\RoutingMode;
use App\Support\AdaptiveMaxSensitivity;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** The adaptive maximum-green sensitivity's curves for the report's Figure A10 - null until both arms have run. */
class ResultsAdaptiveMaxSensitivityController extends Controller
{
    public function __invoke(Request $request, AdaptiveMaxSensitivity $adaptiveMaxSensitivity): JsonResponse
    {
        $routingMode = RoutingMode::tryFrom((string) $request->query('routing')) ?? RoutingMode::Random;

        return response()->json($adaptiveMaxSensitivity->for($request->query('corridor'), $routingMode));
    }
}
