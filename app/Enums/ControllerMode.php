<?php

namespace App\Enums;

/**
 * How a run's signals were controlled (runHeadless.js's controllerMode). Colours match
 * resources/js/charts/theme.js's MODE_COLOURS.
 */
enum ControllerMode: string
{
    case Fixed = 'fixed';
    case Adaptive = 'adaptive';
    case GreenWave = 'green_wave';
    case CoordinatedAdaptive = 'coordinated_adaptive';

    public function label(): string
    {
        return match ($this) {
            self::Fixed => 'Fixed-time',
            self::Adaptive => 'Adaptive',
            self::GreenWave => 'Green wave',
            self::CoordinatedAdaptive => 'Coordinated adaptive',
        };
    }

    /** The actuated modes read a sensor, so their results are broken out per sensor model as well as averaged. */
    public function splitsBySensor(): bool
    {
        return match ($this) {
            self::Adaptive, self::CoordinatedAdaptive => true,
            self::Fixed, self::GreenWave => false,
        };
    }

    public function colour(): string
    {
        return match ($this) {
            self::Fixed => '#ea580c',
            self::Adaptive => '#8b5cf6',
            self::GreenWave => '#059669',
            self::CoordinatedAdaptive => '#f43f5e',
        };
    }
}
