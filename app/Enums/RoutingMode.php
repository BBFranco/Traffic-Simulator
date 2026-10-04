<?php

namespace App\Enums;

/**
 * How a batch's cars chose their way (corridor.js's `routing.mode`): random
 * turning by turn chances, or trips to a destination along a route.
 */
enum RoutingMode: string
{
    case Random = 'random';
    case Destination = 'destination';

    public function label(): string
    {
        return match ($this) {
            self::Random => 'Random turning',
            self::Destination => 'Destination routing',
        };
    }
}
