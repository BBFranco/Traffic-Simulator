<?php

namespace App\Enums;

/**
 * The adaptive maximum-green sensitivity's two arms - each a 'sensitivity' batch, told apart by the `--tag` that
 * batch/runBatch.mjs stores in raw_config_json.tag. SARTSM: maximum greens capped so a cycle stays within 120 s
 * (controllers/phasePlan.js's sartsmMaxGreens()); Default: the same build with the usual 45 s maximum.
 */
enum AdaptiveMaxArm: string
{
    case Sartsm = 'adaptive-max-sartsm';
    case Default = 'adaptive-max-45';
}
