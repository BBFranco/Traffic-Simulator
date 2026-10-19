<?php

namespace App\Enums;

/**
 * Which sensor observation models a run used (resources/js/sim/sensorSpecs.js): the field hardware models, or the
 * legacy reproduction of the pre-2026-10-15 sensors.
 */
enum SensorSpecSet: string
{
    case Field = 'field';
    case Legacy = 'legacy';
}
