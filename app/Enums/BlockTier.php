<?php

namespace App\Enums;

use ValueError;

/**
 * A routing block's destination density (corridor.js's `routing.blocks[].tier`,
 * routing/config.js's BLOCK_TIERS) - stored in the config as the plain number.
 */
enum BlockTier: string
{
    case LowerMedium = '1.5';
    case Medium = '2';
    case MediumHigh = '3';
    case High = '4';
    case VeryHigh = '5';

    /** The number as the corridor JSON holds it - an int where it is whole. */
    public function number(): int|float
    {
        $number = (float) $this->value;

        return floor($number) === $number ? (int) $number : $number;
    }

    public static function fromNumber(int|float|string $number): self
    {
        return collect(self::cases())->first(fn (self $tier) => (float) $tier->value === (float) $number)
            ?? throw new ValueError("No block tier {$number}.");
    }
}
