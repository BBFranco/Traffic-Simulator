<?php

namespace App\Http\Controllers;

use App\Models\SimulationRun;
use App\Models\SimulationRunRecoveryTick;
use App\Support\CorridorRepository;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\View\View;

/**
 * Results dashboard - build step 19: real Eloquent aggregates against
 * `simulation_runs`, replacing Phase 1's hardcoded fake data. The chart
 * layout built in Phase 1 is untouched; only the data source changed.
 *
 * The recovery-over-time line chart is the one exception: `simulation_runs`
 * stores one summary row per run (spec's DB schema), so that per-tick series
 * comes from `simulation_run_recovery_ticks` instead - one representative
 * run's curve per (controller_mode, sensor_mode), captured by the batch
 * runner alongside the summary rows - see dbRecoveryTimeline() below and
 * SimulationRunRecoveryTick's docblock for why a separate table.
 */
class ResultsController extends Controller
{
    private const CONTROLLER_MODES = ['fixed', 'adaptive', 'green_wave'];

    private const POWER_STATES = ['normal', 'load_shedding'];

    /**
     * Every scope the results page's Total/Main Arterial/Side Streets filter can select -
     * '' (unsuffixed columns) means Total, the rest suffix onto every scoped metric column.
     */
    private const SCOPES = ['' => 'total', '_arterial' => 'arterial', '_side_street' => 'side_street'];

    /**
     * Total-scope-only columns (no `_arterial`/`_side_street` counterpart) - the
     * pre/during/post outage segments and the full-run wait distribution added
     * alongside the results-page audit's other fixes.
     */
    private const TOTAL_ONLY_METRICS = [
        'avg_wait_time_pre_outage',
        'avg_wait_time_during_outage',
        'avg_wait_time_post_recovery',
        'throughput_per_min_pre_outage',
        'throughput_per_min_during_outage',
        'throughput_per_min_post_recovery',
        'median_wait_time',
        'p95_wait_time',
        'max_wait_time',
    ];

    public function __construct(private readonly CorridorRepository $corridors) {}

    public function index(): View
    {
        $payload = $this->buildPayload(request()->query('corridor'), request()->query('sensor'));

        return view('results', [
            'isFakeData' => $payload['totalRuns'] === 0,
            'corridors' => $this->corridors->index(),
            'controllerModes' => self::CONTROLLER_MODES,
            'powerStates' => self::POWER_STATES,
            ...$payload,
        ]);
    }

    /** JSON refresh for the batch-run button (build step 17) - same shape as the Blade payload, no page reload needed. */
    public function data(): JsonResponse
    {
        $payload = $this->buildPayload(request()->query('corridor'), request()->query('sensor'));

        return response()->json([
            'aggregates' => $payload['aggregates'],
            'aggregatesBySensor' => $payload['aggregatesBySensor'],
            'controllerModes' => self::CONTROLLER_MODES,
            'powerStates' => self::POWER_STATES,
            'recoveryTimeline' => $payload['recoveryTimeline'],
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function buildPayload(?string $corridorFilter, ?string $sensorFilter): array
    {
        $query = SimulationRun::query();
        if ($corridorFilter) {
            $query->where('corridor_config', $corridorFilter);
        }
        if ($sensorFilter && $sensorFilter !== 'all') {
            $query->where('sensor_mode', $sensorFilter);
        }

        $aggregates = $this->aggregates((clone $query));
        $aggregatesBySensor = $this->aggregatesBySensor((clone $query));
        $recentRuns = (clone $query)->latest('created_at')->limit(10)->get()
            ->map(fn (SimulationRun $run) => [
                'id' => $run->id,
                'seed' => $run->seed,
                'controller_mode' => $run->controller_mode,
                'power_state' => $run->power_state,
                'sensor_mode' => $run->sensor_mode,
                'corridor_config' => $run->corridor_config,
                'avg_wait_time' => $run->avg_wait_time,
                'avg_wait_time_arterial' => $run->avg_wait_time_arterial,
                'avg_wait_time_side_street' => $run->avg_wait_time_side_street,
                'throughput_per_min' => $run->throughput_per_min,
                'throughput_per_min_arterial' => $run->throughput_per_min_arterial,
                'throughput_per_min_side_street' => $run->throughput_per_min_side_street,
                'pct_cleared_without_stop' => $run->pct_cleared_without_stop,
                'pct_cleared_without_stop_arterial' => $run->pct_cleared_without_stop_arterial,
                'pct_cleared_without_stop_side_street' => $run->pct_cleared_without_stop_side_street,
                'time_to_recovery_seconds' => $run->time_to_recovery_seconds,
                'time_to_recovery_seconds_arterial' => $run->time_to_recovery_seconds_arterial,
                'time_to_recovery_seconds_side_street' => $run->time_to_recovery_seconds_side_street,
            ])->all();

        return [
            'aggregates' => $aggregates,
            'aggregatesBySensor' => $aggregatesBySensor,
            'pairedComparisons' => $this->pairedComparisons($aggregates, $aggregatesBySensor),
            'recoveryTimeline' => $this->dbRecoveryTimeline(),
            'recentRuns' => $recentRuns,
            'totalRuns' => (clone $query)->count(),
        ];
    }

    /**
     * One row per controller_mode x power_state - the real groupBy aggregate
     * the Phase 1 fake data was already shaped to match.
     *
     * @return array<int, array<string, mixed>>
     */
    /** @param  Builder<SimulationRun>  $query */
    private function aggregates(Builder $query): array
    {
        $stddevs = $this->computeStddevs((clone $query), ['controller_mode', 'power_state']);

        return $query
            ->selectRaw('controller_mode, power_state, count(*) as runs, '.$this->metricSelectRaw())
            ->groupBy('controller_mode', 'power_state')
            ->get()
            ->map(fn ($row) => [
                'controller_mode' => $row->controller_mode,
                'power_state' => $row->power_state,
                'runs' => (int) $row->runs,
                ...$this->metricRow($row, $stddevs["{$row->controller_mode}|{$row->power_state}"] ?? []),
            ])
            ->all();
    }

    /**
     * Every scoped metric's `avg(...)` clause for a groupBy aggregate query - shared by
     * aggregates() and aggregatesBySensor() so the Total/Arterial/Side-Streets columns
     * (see SCOPES) stay in lockstep between both.
     */
    private function metricSelectRaw(): string
    {
        $clauses = [];
        foreach (['avg_wait_time', 'throughput_per_min', 'pct_cleared_without_stop', 'time_to_recovery_seconds'] as $metric) {
            foreach (array_keys(self::SCOPES) as $suffix) {
                $column = $metric.$suffix;
                $clauses[] = "avg({$column}) as {$column}";
            }
        }
        foreach (self::TOTAL_ONLY_METRICS as $column) {
            $clauses[] = "avg({$column}) as {$column}";
        }

        return implode(', ', $clauses);
    }

    /** Every scoped (Total/Arterial/Side-Streets) column of the four paired-comparison metrics. */
    private function scopedMetricColumns(): array
    {
        $columns = [];
        foreach (['avg_wait_time', 'throughput_per_min', 'pct_cleared_without_stop', 'time_to_recovery_seconds'] as $metric) {
            foreach (array_keys(self::SCOPES) as $suffix) {
                $columns[] = $metric.$suffix;
            }
        }

        return $columns;
    }

    /**
     * Sample stddev per group, across the group's reps - with 30 seeded reps per condition
     * this is what lets a viewer tell a small delta (e.g. +2.6%) apart from noise. A
     * per-condition figure, not a paired stddev of the delta itself (that would need
     * per-seed joins across conditions) - labelled as such in the UI.
     *
     * Computed in PHP rather than pushed into the aggregate SQL (`avg()` above): this app's
     * dev/test DB is SQLite, which has no STDDEV_SAMP, and hand-rolling it as
     * sqrt(avg(x*x) - avg(x)^2) would be numerically shakier than just fetching the (at most
     * a few hundred) raw rows once and computing it directly.
     *
     * @return array<string, array<string, float|null>> group key -> column -> stddev
     */
    /** @param  Builder<SimulationRun>  $query */
    private function computeStddevs(Builder $query, array $groupColumns): array
    {
        $metricColumns = $this->scopedMetricColumns();
        $rows = $query->select(array_merge($groupColumns, $metricColumns))->get();

        $valuesByGroup = [];
        foreach ($rows as $row) {
            $key = implode('|', array_map(fn ($c) => (string) ($row->$c ?? ''), $groupColumns));
            foreach ($metricColumns as $column) {
                $valuesByGroup[$key][$column][] = $row->$column;
            }
        }

        $stddevs = [];
        foreach ($valuesByGroup as $key => $columns) {
            foreach ($columns as $column => $values) {
                $stddevs[$key][$column] = $this->sampleStddev($values);
            }
        }

        return $stddevs;
    }

    private function sampleStddev(array $values): ?float
    {
        $values = array_values(array_filter($values, fn ($v) => $v !== null));
        $n = count($values);
        if ($n < 2) {
            return null;
        }

        $mean = array_sum($values) / $n;
        $variance = array_sum(array_map(fn ($v) => ($v - $mean) ** 2, $values)) / ($n - 1);

        return sqrt($variance);
    }

    /**
     * Rounds every scoped metric column on an aggregate row - shared by aggregates() and
     * aggregatesBySensor(). time_to_recovery_seconds* stays null-safe (no run in the group
     * measured a recovery, e.g. all normal-power); the other three are never null on a
     * populated row but a legacy pre-migration row can still average to null (see the
     * scope-columns migration's docblock).
     *
     * @return array<string, float|null>
     */
    private function metricRow(object $row, array $stddevByColumn = []): array
    {
        $result = [];
        $runs = (int) $row->runs;
        foreach (['avg_wait_time', 'throughput_per_min', 'pct_cleared_without_stop', 'time_to_recovery_seconds'] as $metric) {
            foreach (array_keys(self::SCOPES) as $suffix) {
                $column = $metric.$suffix;
                $result[$column] = $row->$column === null ? null : round((float) $row->$column, 1);

                $stddev = $stddevByColumn[$column] ?? null;
                // 95% CI half-width on THIS condition's own mean (mean +/- ci95), not on a
                // delta - needs >= 2 reps to have a defined stddev at all.
                $result[$column.'_ci95'] = ($stddev === null || $runs < 2)
                    ? null
                    : round(1.96 * $stddev / sqrt($runs), 1);
            }
        }
        foreach (self::TOTAL_ONLY_METRICS as $column) {
            $result[$column] = $row->$column === null ? null : round((float) $row->$column, 1);
        }

        return $result;
    }

    /**
     * Same shape as aggregates(), but also split by sensor_mode - fixed-time never reads one
     * (always null) and green-wave always uses the matrix's fixed 'inductive_loop' placeholder
     * (see experimentalMatrix.js's comment on why it's tested against only one), so both still
     * collapse to a single row; only adaptive actually varies here, into up to 4 rows. Kept
     * separate from aggregates() - which stays mode+power only - so the "does ITS beat fixed-time"
     * cards and the bar-chart trio keep showing one overall adaptive number apiece, not one per
     * sensor; only the data table underneath the bar-chart trio consumes this finer breakdown.
     *
     * @return array<int, array<string, mixed>>
     */
    /** @param  Builder<SimulationRun>  $query */
    private function aggregatesBySensor(Builder $query): array
    {
        $stddevs = $this->computeStddevs((clone $query), ['controller_mode', 'power_state', 'sensor_mode']);

        return $query
            ->selectRaw('controller_mode, power_state, sensor_mode, count(*) as runs, '.$this->metricSelectRaw())
            ->groupBy('controller_mode', 'power_state', 'sensor_mode')
            ->get()
            ->map(fn ($row) => [
                'controller_mode' => $row->controller_mode,
                'power_state' => $row->power_state,
                'sensor_mode' => $row->sensor_mode,
                'runs' => (int) $row->runs,
                ...$this->metricRow($row, $stddevs["{$row->controller_mode}|{$row->power_state}|{$row->sensor_mode}"] ?? []),
            ])
            ->all();
    }

    /**
     * The dissertation's research question, answered directly: each ITS mode
     * against the fixed-time baseline, separately under normal power and
     * under load shedding.
     *
     * Adaptive isn't one thing - it's whichever of the 4 sensor models is
     * reading the intersection, and they perform differently enough that a
     * single blended "adaptive" row hides which sensor actually earns its
     * keep. So adaptive gets one comparison per sensor mode (from
     * aggregatesBySensor) plus one "average of all sensors" row, while
     * green-wave - which never varies by sensor - keeps its single row.
     *
     * @param  array<int, array<string, mixed>>  $aggregates
     * @param  array<int, array<string, mixed>>  $aggregatesBySensor
     * @return array<int, array<string, mixed>>
     */
    private function pairedComparisons(array $aggregates, array $aggregatesBySensor): array
    {
        $lookup = [];
        foreach ($aggregates as $row) {
            $lookup["{$row['controller_mode']}|{$row['power_state']}"] = $row;
        }

        $comparisons = [];

        foreach (self::SCOPES as $suffix => $scope) {
            foreach (['adaptive', 'green_wave'] as $mode) {
                foreach (self::POWER_STATES as $power) {
                    $subject = $lookup["{$mode}|{$power}"] ?? null;
                    $baseline = $lookup['fixed|'.$power] ?? null;
                    if (! $subject || ! $baseline) {
                        continue;
                    }

                    $comparisons[] = $this->buildComparison(
                        $mode,
                        $mode === 'adaptive' ? 'average' : null,
                        $power,
                        $scope,
                        $suffix,
                        $subject,
                        $baseline
                    );
                }
            }

            $bySensor = [];
            foreach ($aggregatesBySensor as $row) {
                if ($row['controller_mode'] !== 'adaptive' || $row['sensor_mode'] === null) {
                    continue;
                }
                $bySensor["{$row['sensor_mode']}|{$row['power_state']}"] = $row;
            }

            foreach ($bySensor as $key => $subject) {
                [$sensor, $power] = explode('|', $key);
                $baseline = $lookup['fixed|'.$power] ?? null;
                if (! $baseline) {
                    continue;
                }

                $comparisons[] = $this->buildComparison('adaptive', $sensor, $power, $scope, $suffix, $subject, $baseline);
            }
        }

        return $comparisons;
    }

    /**
     * @param  array<string, mixed>  $subject
     * @param  array<string, mixed>  $baseline
     * @return array<string, mixed>
     */
    private function buildComparison(
        string $mode,
        ?string $sensorMode,
        string $power,
        string $scope,
        string $suffix,
        array $subject,
        array $baseline
    ): array {
        $waitKey = 'avg_wait_time'.$suffix;
        $throughputKey = 'throughput_per_min'.$suffix;
        $clearedKey = 'pct_cleared_without_stop'.$suffix;
        $recoveryKey = 'time_to_recovery_seconds'.$suffix;

        // Every metric can be null here, not just recovery: a group made up entirely of
        // pre-scope-migration rows averages to null on every `_arterial`/`_side_street`
        // column (see the scope-columns migration's docblock) until fresh data replaces it.
        $waitKnown = $subject[$waitKey] !== null && $baseline[$waitKey] !== null;
        $throughputKnown = $subject[$throughputKey] !== null && $baseline[$throughputKey] !== null;
        $clearedKnown = $subject[$clearedKey] !== null && $baseline[$clearedKey] !== null;
        $recoveryKnown = $subject[$recoveryKey] !== null && $baseline[$recoveryKey] !== null;

        return [
            'mode' => $mode,
            'sensor_mode' => $sensorMode,
            'baseline' => 'fixed',
            'power_state' => $power,
            'scope' => $scope,
            // Wait time: lower is better, so a negative delta is an improvement.
            'wait_delta_pct' => $waitKnown ? $this->pctChange($baseline[$waitKey], $subject[$waitKey]) : null,
            'throughput_delta_pct' => $throughputKnown
                ? $this->pctChange($baseline[$throughputKey], $subject[$throughputKey])
                : null,
            'cleared_delta_pp' => $clearedKnown ? round($subject[$clearedKey] - $baseline[$clearedKey], 1) : null,
            // Recovery time: only meaningful under load shedding (null otherwise); lower is better.
            'recovery_delta_pct' => $recoveryKnown
                ? $this->pctChange($baseline[$recoveryKey], $subject[$recoveryKey])
                : null,
            'wait_improves' => $waitKnown ? $subject[$waitKey] < $baseline[$waitKey] : null,
            'throughput_improves' => $throughputKnown ? $subject[$throughputKey] > $baseline[$throughputKey] : null,
            'cleared_improves' => $clearedKnown ? $subject[$clearedKey] > $baseline[$clearedKey] : null,
            'recovery_improves' => $recoveryKnown
                ? $subject[$recoveryKey] < $baseline[$recoveryKey]
                : null,
            // Sample size behind this row's own mean, and each side's 95% CI half-width
            // (mean +/- ci95) - not a CI on the delta itself, see metricSelectRaw()'s comment.
            'runs' => $subject['runs'],
            'baseline_runs' => $baseline['runs'],
            'wait_ci95' => $subject[$waitKey.'_ci95'] ?? null,
            'baseline_wait_ci95' => $baseline[$waitKey.'_ci95'] ?? null,
            'throughput_ci95' => $subject[$throughputKey.'_ci95'] ?? null,
            'baseline_throughput_ci95' => $baseline[$throughputKey.'_ci95'] ?? null,
            'cleared_ci95' => $subject[$clearedKey.'_ci95'] ?? null,
            'baseline_cleared_ci95' => $baseline[$clearedKey.'_ci95'] ?? null,
        ];
    }

    private function pctChange(float $from, float $to): float
    {
        if ($from == 0.0) {
            return 0.0;
        }

        return round((($to - $from) / $from) * 100, 1);
    }

    /**
     * Per-tick throughput and avg wait, one representative load-shedding run per
     * (controller_mode, sensor_mode) - see SimulationRunRecoveryTick's
     * docblock. Keyed the same way as pairedComparisons()'s cards
     * (`"{mode}|{sensor_mode}"`, empty string for the two modes that never
     * vary by sensor) so results.js can look a series up directly by
     * whatever the "Compare against fixed-time" dropdown has selected.
     * Returns null until the batch runner has actually captured one - there
     * is no fallback to fake data here, an empty/missing chart is the honest
     * state before a run exists.
     *
     * @return array{seconds: array<int, float>, series: array<string, array<string, array<int, ?float>>>, sheddingStart: ?float, sheddingEnd: ?float}|null
     */
    private function dbRecoveryTimeline(): ?array
    {
        $rows = SimulationRunRecoveryTick::query()->orderBy('tick')->get();
        if ($rows->isEmpty()) {
            return null;
        }

        $seconds = null;
        $series = [];
        $sheddingStart = null;
        $sheddingEnd = null;

        foreach ($rows->groupBy(fn (SimulationRunRecoveryTick $row) => "{$row->controller_mode}|{$row->sensor_mode}") as $key => $conditionRows) {
            $seconds ??= $conditionRows->pluck('seconds')->map(fn ($v) => round((float) $v, 1))->all();
            $series[$key] = [];
            foreach (self::SCOPES as $suffix => $scope) {
                $series[$key]['throughput_per_min'.$suffix] = $conditionRows
                    ->pluck('throughput_per_min'.$suffix)
                    ->map(fn ($v) => $v === null ? null : round((float) $v, 1))
                    ->all();
                $series[$key]['avg_wait_time'.$suffix] = $conditionRows
                    ->pluck('avg_wait_time'.$suffix)
                    ->map(fn ($v) => $v === null ? null : round((float) $v, 1))
                    ->all();
            }
            $sheddingStart ??= round((float) $conditionRows->first()->power_event_seconds, 1);
            $sheddingEnd ??= $conditionRows->first()->power_outage_end_seconds === null
                ? null
                : round((float) $conditionRows->first()->power_outage_end_seconds, 1);
        }

        return [
            'seconds' => $seconds,
            'series' => $series,
            // Power is actually restored at `sheddingEnd` (see runBatch.mjs/results.js's
            // outage schedule) - a legacy row captured before that existed has no restore
            // time on record, so its band falls back to "trigger to end of series" rather
            // than claiming a restore that was never simulated.
            'sheddingStart' => $sheddingStart,
            'sheddingEnd' => $sheddingEnd ?? ($sheddingStart === null ? null : end($seconds)),
        ];
    }
}
