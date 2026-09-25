<?php

namespace App\Enums;

/**
 * Where an approach's lane use lives in a corridor config: the arterial
 * intersection's own `laneUse`, or a connector's `laneUse` keyed by the
 * compass direction its traffic runs (see corridor.js's buildApproaches()).
 */
enum LaneUseApproach: string
{
    case Arterial = 'arterial';
    case Northbound = 'northbound';
    case Southbound = 'southbound';
    case Eastbound = 'eastbound';
    case Westbound = 'westbound';
}
