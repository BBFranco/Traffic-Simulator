<?php

namespace App\Enums;

/**
 * What a batch is for: the dataset Results reports on, or a sensitivity batch (different
 * signal-timing rules, fewer reps) that only feeds the report's appendix.
 */
enum BatchKind: string
{
    case Main = 'main';
    case Sensitivity = 'sensitivity';
}
