<?php

namespace App\Enums;

/**
 * Which side of an approach a turn lane is added on (corridor.js's
 * `turnLanes`): left is the kerb side in left-hand traffic, right the median side.
 */
enum TurnLaneSide: string
{
    case Left = 'left';
    case Right = 'right';
}
