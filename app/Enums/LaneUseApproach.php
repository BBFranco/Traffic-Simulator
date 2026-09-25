<?php

namespace App\Enums;

/**
 * Where an approach's lane use lives in a corridor config: a one-way arterial
 * intersection's own `laneUse`, or - keyed by the compass direction its
 * traffic runs - a two-way arterial intersection's or a connector's
 * (see corridor.js's buildApproaches()).
 */
enum LaneUseApproach: string
{
    case Arterial = 'arterial';
    case Northbound = 'northbound';
    case Southbound = 'southbound';
    case Eastbound = 'eastbound';
    case Westbound = 'westbound';

    /** The other direction along the same street - null for the one-way arterial key. */
    public function opposite(): ?self
    {
        return match ($this) {
            self::Arterial => null,
            self::Northbound => self::Southbound,
            self::Southbound => self::Northbound,
            self::Eastbound => self::Westbound,
            self::Westbound => self::Eastbound,
        };
    }
}
