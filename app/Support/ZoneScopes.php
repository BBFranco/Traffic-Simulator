<?php

namespace App\Support;

use App\Models\SimulationRun;

/**
 * The rolling-blackout zone scopes (zone1..zone3) read like the column scopes: `<metric>_zone1` follows the same
 * `<metric><suffix>` convention as `<metric>_arterial`, but its value comes from the run's `zone_stats` JSON
 * (runHeadless.js's zoneSummary()) instead of a column. Null where a run has no zone figures (before zones existed).
 */
class ZoneScopes
{
    /** Suffix => scope, in the order the Results page lists them. */
    public const SUFFIXES = ['_zone1' => 'zone1', '_zone2' => 'zone2', '_zone3' => 'zone3'];

    /** Column metric => zone_stats field. */
    private const FIELDS = [
        'avg_wait_time' => 'avgWaitTime',
        'throughput_per_min' => 'throughputPerMin',
        'pct_cleared_without_stop' => 'pctClearedWithoutStop',
        'time_to_recovery_seconds' => 'timeToRecoverySeconds',
        'time_to_recovery_wait_seconds' => 'timeToRecoveryWaitSeconds',
        'median_wait_time' => 'medianWait',
        'p95_wait_time' => 'p95Wait',
        'max_wait_time' => 'maxWait',
        'restore_seconds' => 'restoreSeconds',
        'post_restore_window_s' => 'postRestoreWindowS',
    ];

    /** Segment column part => zone_stats segment key. */
    private const SEGMENTS = [
        'pre_outage' => 'pre',
        'during_outage' => 'during',
        'post_recovery' => 'post',
        'stage1' => 'stage1',
        'stage2' => 'stage2',
    ];

    /** Segment metric => the segment's field. */
    private const SEGMENT_FIELDS = ['avg_wait_time' => 'avgWaitTime', 'throughput_per_min' => 'throughputPerMin'];

    public function isZoneColumn(string $column): bool
    {
        return $this->split($column) !== null;
    }

    /** A zone column's value on one run, e.g. `avg_wait_time_zone1` or `throughput_per_min_stage2_zone2`. */
    public function value(SimulationRun $run, string $column): ?float
    {
        [$metric, $zone] = $this->split($column) ?? [null, null];
        $zoneStats = $this->decoded($run)[$zone] ?? null;
        if ($metric === null || $zoneStats === null) {
            return null;
        }

        $value = isset(self::FIELDS[$metric])
            ? $zoneStats[self::FIELDS[$metric]] ?? null
            : $this->segmentValue($zoneStats['segments'] ?? null, $metric);

        return $value === null ? null : (float) $value;
    }

    /**
     * Every zone column of these metrics, for every zone.
     *
     * @param  array<int, string>  $metrics
     * @return array<int, string>
     */
    public function columns(array $metrics): array
    {
        return collect(self::SUFFIXES)->keys()
            ->flatMap(fn (string $suffix): array => collect($metrics)->map(fn (string $metric): string => $metric.$suffix)->all())
            ->all();
    }

    /**
     * A run's zone_stats, decoded once: the array cast re-decodes the JSON on every attribute read, and the Results
     * page reads it hundreds of thousands of times per load.
     *
     * @return array<string, mixed>
     */
    private function decoded(SimulationRun $run): array
    {
        static $cache = null;
        $cache ??= new \WeakMap;

        return $cache[$run] ??= $run->zone_stats ?? [];
    }

    private function segmentValue(?array $segments, string $metric): int|float|null
    {
        foreach (self::SEGMENT_FIELDS as $prefix => $field) {
            $segment = self::SEGMENTS[substr($metric, strlen($prefix) + 1)] ?? null;
            if (str_starts_with($metric, $prefix.'_') && $segment !== null) {
                return $segments[$segment][$field] ?? null;
            }
        }

        return null;
    }

    /** @return array{0: string, 1: string}|null [metric, zone] */
    private function split(string $column): ?array
    {
        foreach (self::SUFFIXES as $suffix => $zone) {
            if (str_ends_with($column, $suffix)) {
                return [substr($column, 0, -strlen($suffix)), $zone];
            }
        }

        return null;
    }
}
