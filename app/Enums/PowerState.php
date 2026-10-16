<?php

namespace App\Enums;

/**
 * The power a run's signals had (runHeadless.js's powerState). `load_shedding` keeps its old value but reads as a
 * total blackout: every junction dark at once. A rolling blackout darkens zones in stages (batchSchedule.js's
 * ROLLING_SCHEDULE).
 */
enum PowerState: string
{
    case Normal = 'normal';
    case LoadShedding = 'load_shedding';
    case RollingBlackout = 'rolling_blackout';

    public function label(): string
    {
        return match ($this) {
            self::Normal => 'Normal',
            self::LoadShedding => 'Total blackout',
            self::RollingBlackout => 'Rolling blackout',
        };
    }

    /** Some junction went dark during the run, so it has outage segments and a recovery. */
    public function isOutage(): bool
    {
        return $this !== self::Normal;
    }

    /** @return array<int, string> */
    public static function values(): array
    {
        return array_column(self::cases(), 'value');
    }

    /** @return array<string, string> value => label */
    public static function options(): array
    {
        return collect(self::cases())->mapWithKeys(fn (self $state): array => [$state->value => $state->label()])->all();
    }

    /** @return array<int, string> */
    public static function outageValues(): array
    {
        return collect(self::cases())->filter(fn (self $state): bool => $state->isOutage())->map(fn (self $state): string => $state->value)->values()->all();
    }
}
