<?php

namespace App\Support;

/**
 * 95% confidence half-widths on a mean of n samples: Student's t on n - 1 degrees of freedom, not
 * the normal 1.96 - at 10 paired seeds that is 2.26, about 15% wider.
 */
class ConfidenceInterval
{
    /** Two-sided 95% t critical values by degrees of freedom; 1.96 beyond the table. */
    private const T_95 = [
        1 => 12.706, 2 => 4.303, 3 => 3.182, 4 => 2.776, 5 => 2.571, 6 => 2.447, 7 => 2.365, 8 => 2.306, 9 => 2.262, 10 => 2.228,
        11 => 2.201, 12 => 2.179, 13 => 2.160, 14 => 2.145, 15 => 2.131, 16 => 2.120, 17 => 2.110, 18 => 2.101, 19 => 2.093, 20 => 2.086,
        21 => 2.080, 22 => 2.074, 23 => 2.069, 24 => 2.064, 25 => 2.060, 26 => 2.056, 27 => 2.052, 28 => 2.048, 29 => 2.045, 30 => 2.042,
        40 => 2.021, 60 => 2.000, 120 => 1.980,
    ];

    public static function halfWidth95(float $stddev, int $samples): float
    {
        return self::tCritical($samples - 1) * $stddev / sqrt($samples);
    }

    private static function tCritical(int $degreesOfFreedom): float
    {
        if ($degreesOfFreedom < 1) {
            return INF;
        }

        return collect(self::T_95)->first(fn (float $t, int $df): bool => $df >= $degreesOfFreedom) ?? 1.96;
    }
}
