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
 * comes from `simulation_run_recovery_ticks` instead - one curve per
 * (controller_mode, sensor_mode), averaged across every rep of that
 * condition by the batch runner (recoveryTickPayload.js) so the chart tracks
 * the same population the "time to recovery" stat card averages - see
 * dbRecoveryTimeline() below and SimulationRunRecoveryTick's docblock for why
 * a separate table.
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
     * Every metric that has a `_arterial`/`_side_street` counterpart alongside its
     * unsuffixed (Total) column - shared by metricSelectRaw(), scopedMetricColumns(), and
     * metricRow() so the three stay in lockstep.
     */
    private const SCOPED_METRICS = [
        'avg_wait_time',
        'throughput_per_min',
        'pct_cleared_without_stop',
        'time_to_recovery_seconds',
        'time_to_recovery_wait_seconds',
        'avg_wait_time_pre_outage',
        'avg_wait_time_during_outage',
        'avg_wait_time_post_recovery',
        'throughput_per_min_pre_outage',
        'throughput_per_min_during_outage',
        'throughput_per_min_post_recovery',
    ];

    /**
     * Total-scope-only columns (no `_arterial`/`_side_street` counterpart) - the full-run
     * wait distribution added alongside the results-page audit's other fixes.
     */
    private const TOTAL_ONLY_METRICS = [
        'median_wait_time',
        'p95_wait_time',
        'max_wait_time',
    ];

    public function __construct(private readonly CorridorRepository $corridors) {}

    public function index(): View
    {
        $payload = $this->buildPayload(request()->query('corridor'));

        return view('results', [
            'isFakeData' => $payload['totalRuns'] === 0,
            'corridors' => $this->corridors->index(),
            'controllerModes' => self::CONTROLLER_MODES,
            'powerStates' => self::POWER_STATES,
            ...$payload,
            ...$this->viewModel($payload),
        ]);
    }

    /**
     * JSON refresh for the batch-run button (build step 17) AND for the Corridor filter. Early
     * on this only returned `aggregates`/`aggregatesBySensor`/`recoveryTimeline`, which just fed
     * the chart trio - every other chunk of the page (the "vs fixed-time" cards, the
     * per-condition/segmented table rows, Recent Runs) stayed rendered from whatever the initial
     * GET happened to load, so switching Corridor silently left most of the page showing stale
     * data - a real bug, not a cosmetic one, since those cards are the page's actual headline.
     * Rather than re-deriving all of Blade's tone/formatting logic in JS (a second copy to keep
     * in sync), this renders the same partials the initial page uses with fresh data and ships
     * the HTML - results.js just swaps it in and re-applies the client-side togglers
     * (Compare-against-fixed-time, Scope) on top.
     */
    public function data(): JsonResponse
    {
        $payload = $this->buildPayload(request()->query('corridor'));
        $viewData = [
            ...$payload,
            ...$this->viewModel($payload),
            'controllerModes' => self::CONTROLLER_MODES,
            'powerStates' => self::POWER_STATES,
        ];

        return response()->json([
            'aggregates' => $payload['aggregates'],
            'aggregatesBySensor' => $payload['aggregatesBySensor'],
            'controllerModes' => self::CONTROLLER_MODES,
            'powerStates' => self::POWER_STATES,
            'recoveryTimeline' => $payload['recoveryTimeline'],
            'html' => [
                'researchQuestionCards' => view('results.partials.research-question-cards', $viewData)->render(),
                'metricSectionGroups' => view('results.partials.metric-section-groups', $viewData)->render(),
                'perConditionRows' => view('results.partials.per-condition-rows', $viewData)->render(),
                'segmentedRows' => view('results.partials.segmented-rows', $viewData)->render(),
                'recentRunsRows' => view('results.partials.recent-runs-rows', $viewData)->render(),
                'itsTargetOptions' => view('results.partials.its-target-options', $viewData)->render(),
            ],
        ]);
    }

    /**
     * Every display-only value derived from a payload (labels, colours, formatters, lookups) -
     * shared between the full-page render and data()'s partial refresh so the two never drift
     * out of sync with each other. Used to live inline in results.blade.php's top `@php` block;
     * moved here once data() started needing the exact same derivations to render partials.
     *
     * @return array<string, mixed>
     */
    private function viewModel(array $payload): array
    {
        $modeLabels = ['fixed' => 'Fixed-time', 'adaptive' => 'Adaptive', 'green_wave' => 'Green wave'];
        $modeColours = ['fixed' => '#ea580c', 'adaptive' => '#8b5cf6', 'green_wave' => '#059669'];
        $powerLabels = ['normal' => 'Normal power', 'load_shedding' => 'Load shedding'];
        $sensorLabels = [
            'none' => 'None (timer only)',
            'inductive_loop' => 'Inductive loop',
            'radar' => 'Radar',
            'camera' => 'Camera',
            'magnetometer' => 'Magnetometer',
        ];

        // Data-table breakdown: fixed-time and green-wave collapse to one row apiece (see
        // aggregatesBySensor()'s docblock), adaptive gets one row per sensor mode.
        $sensorOrder = ['inductive_loop', 'radar', 'camera', 'magnetometer'];
        $byKeyBySensor = [];
        foreach ($payload['aggregatesBySensor'] as $row) {
            $byKeyBySensor["{$row['controller_mode']}|{$row['power_state']}"][] = $row;
        }
        foreach ($byKeyBySensor as $key => $rows) {
            usort($rows, fn ($a, $b) => array_search($a['sensor_mode'], $sensorOrder, true) <=> array_search($b['sensor_mode'], $sensorOrder, true));
            $byKeyBySensor[$key] = $rows;
        }

        // Mode+power lookup for the segmented/distribution table - Total scope only, no sensor
        // breakdown (keeps that table to one row per mode+power).
        $byModeAndPower = [];
        foreach ($payload['aggregates'] as $row) {
            $byModeAndPower["{$row['controller_mode']}|{$row['power_state']}"] = $row;
        }

        // "24.1" -> "24.1 ± 1.2" when a 95% CI half-width is available (>= 2 reps).
        $fmtWithCi = fn (?float $value, ?float $ci95, int $decimals = 1) => $value === null
            ? '—'
            : number_format($value, $decimals).($ci95 === null ? '' : ' ± '.number_format($ci95, $decimals));

        // Scope suffix convention shared with SCOPES and results.js's scopedMetric() - drives
        // the per-condition-means and segmented tables, which render all three scopes' rows up
        // front and let JS toggle which is visible (same data-scope mechanism the "vs
        // fixed-time" cards already use).
        $scopeSuffixes = ['total' => '', 'arterial' => '_arterial', 'side_street' => '_side_street'];

        $card = 'rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60';
        $tableHead = 'bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 dark:bg-slate-950/40';
        $select = 'rounded-md border-slate-300 bg-white py-1.5 text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';

        // The "vs fixed-time" stat blocks: adaptive isn't one thing, it's whichever sensor is
        // reading the intersection, so each sensor (plus a blended average) is its own
        // selectable comparison target alongside green-wave - see pairedComparisons(). A
        // comparison's delta can be null - a group made up entirely of pre-scope-migration rows
        // (see the scope-columns migration's docblock), or (for recovery) simply not measured
        // under normal power. Render a neutral placeholder rather than a fabricated number.
        $fmtDelta = fn (?float $v, string $suffix) => $v === null ? '—' : ($v > 0 ? '+' : '').number_format($v, 1).$suffix;

        // Recovery time on its own reads as "how good the controller is at recovering" - it
        // isn't, it only clocks how long throughput takes to sustain its way back to baseline,
        // saying nothing about where wait time actually settles afterwards. Always show it next
        // to that steady-state figure so a short-but-still-elevated recovery can't pass as fully
        // healed.
        $fmtSecondsPair = fn (?float $subject, ?float $baseline, string $suffix = 's') => ($subject === null || $baseline === null)
            ? '—'
            : number_format($subject, 1).$suffix.' vs '.number_format($baseline, 1).$suffix;

        // Recovery time itself (unlike the post-recovery steady-state above) can go unmeasured
        // on either side: computeRecoverySeconds() returns null whenever a metric never sustains
        // its way back to baseline before the run ends - most commonly fixed-time's own
        // wait-time baseline, which this corridor's fixed-cycle signals don't fully clear within
        // the measured post-restore window (a real result, not a data gap - see the
        // results-page audit). Show each side on its own rather than collapsing the whole row to
        // "-" the moment either side is missing, so a subject that DID recover isn't hidden by a
        // baseline that didn't.
        $fmtRecoverySide = fn (?float $v, string $suffix = 's') => $v === null ? 'did not recover in window' : number_format($v, 1).$suffix;

        $comparisonKey = fn (array $c) => $c['mode'].'|'.($c['sensor_mode'] ?? '');
        $comparisonLabel = function (array $c) use ($modeLabels, $sensorLabels) {
            if ($c['mode'] !== 'adaptive') {
                return $modeLabels[$c['mode']];
            }

            return $c['sensor_mode'] === 'average'
                ? 'Adaptive — avg. of sensors'
                : 'Adaptive — '.$sensorLabels[$c['sensor_mode']];
        };

        $comparisonOptions = [];
        foreach ($payload['pairedComparisons'] as $c) {
            $key = $comparisonKey($c);
            if (isset($comparisonOptions[$key])) {
                continue;
            }
            $comparisonOptions[$key] = ['key' => $key, 'label' => $comparisonLabel($c), 'mode' => $c['mode'], 'sensor_mode' => $c['sensor_mode']];
        }
        usort($comparisonOptions, function ($a, $b) use ($sensorOrder) {
            $rank = function ($o) use ($sensorOrder) {
                if ($o['mode'] === 'adaptive' && $o['sensor_mode'] === 'average') {
                    return -1;
                }

                return $o['mode'] === 'adaptive' ? array_search($o['sensor_mode'], $sensorOrder, true) : 100;
            };

            return $rank($a) <=> $rank($b);
        });

        return [
            'modeLabels' => $modeLabels,
            'modeColours' => $modeColours,
            'powerLabels' => $powerLabels,
            'sensorLabels' => $sensorLabels,
            'sensorOrder' => $sensorOrder,
            'byKeyBySensor' => $byKeyBySensor,
            'byModeAndPower' => $byModeAndPower,
            'fmtWithCi' => $fmtWithCi,
            'scopeSuffixes' => $scopeSuffixes,
            'card' => $card,
            'tableHead' => $tableHead,
            'select' => $select,
            'fmtDelta' => $fmtDelta,
            'fmtSecondsPair' => $fmtSecondsPair,
            'fmtRecoverySide' => $fmtRecoverySide,
            'comparisonKey' => $comparisonKey,
            'comparisonLabel' => $comparisonLabel,
            'comparisonOptions' => $comparisonOptions,
            'metricSectionGroups' => $this->metricSectionGroupsConfig(),
        ];
    }

    /**
     * Static config for the "More headline metrics" section groups (throughput, cleared,
     * recovery x2) - doesn't depend on any run data, only on which comparison fields/labels each
     * group headlines. Doesn't belong in buildPayload() (that's real query results); lives here
     * because it's still part of what both the full page and the AJAX partial refresh need.
     *
     * @return array<int, array<int, array<string, mixed>>>
     */
    private function metricSectionGroupsConfig(): array
    {
        return [
            [
                [
                    'heading' => 'Does ITS move more traffic?',
                    'description' => 'Same paired comparison, headlining throughput instead of wait time. Higher is better.',
                    'valueKey' => 'throughput_delta_pct',
                    'improvesKey' => 'throughput_improves',
                    'suffix' => '%',
                    'improvedLabel' => 'more throughput',
                    'worseLabel' => 'less throughput',
                    'unitLabel' => 'vehicles cleared per minute',
                    'secondary' => [
                        ['label' => 'Avg wait', 'key' => 'wait_delta_pct', 'suffix' => '%'],
                        ['label' => 'Cleared w/o stopping', 'key' => 'cleared_delta_pp', 'suffix' => ' pp'],
                    ],
                    'filter' => null,
                ],
            ],
            [
                [
                    'heading' => 'Does ITS clear more traffic without stopping?',
                    'description' => 'Share of vehicles that pass through without a full stop. Higher is better.',
                    'valueKey' => 'cleared_delta_pp',
                    'improvesKey' => 'cleared_improves',
                    'suffix' => ' pp',
                    'improvedLabel' => 'more cleared w/o stopping',
                    'worseLabel' => 'fewer cleared w/o stopping',
                    'unitLabel' => 'percentage-point change',
                    'secondary' => [
                        ['label' => 'Avg wait', 'key' => 'wait_delta_pct', 'suffix' => '%'],
                        ['label' => 'Throughput', 'key' => 'throughput_delta_pct', 'suffix' => '%'],
                    ],
                    'filter' => null,
                ],
            ],
            [
                [
                    'heading' => 'How fast does ITS recover from load shedding? - wait time',
                    'description' => 'Time for wait time to drop back to its pre-cut level once power is restored. Lower is better.',
                    'valueKey' => 'recovery_wait_delta_pct',
                    'improvesKey' => 'recovery_wait_improves',
                    'suffix' => '%',
                    'improvedLabel' => 'faster recovery',
                    'worseLabel' => 'slower recovery',
                    'unitLabel' => 'time to recovery',
                    'secondary' => [
                        ['label' => 'Avg wait', 'key' => 'wait_delta_pct', 'suffix' => '%'],
                        ['label' => 'Throughput', 'key' => 'throughput_delta_pct', 'suffix' => '%'],
                    ],
                    // Deliberately NOT requiring recovery_wait_delta_pct !== null here: fixed-time's
                    // own wait-time baseline routinely never crosses the recovered threshold within
                    // the measured window on this corridor (a real result - see $fmtRecoverySide's
                    // comment above), which would otherwise silently hide every comparison against
                    // it. The card itself renders that as "did not recover in window" instead.
                    'filter' => fn ($c) => $c['power_state'] === 'load_shedding',
                    // Recovery time alone can't be trusted (see $fmtSecondsPair's comment above) -
                    // this card always renders it next to the post-recovery steady-state wait.
                    'recoveryPairMetric' => 'wait',
                ],
                [
                    'heading' => 'How fast does ITS recover from load shedding? - throughput',
                    'description' => 'Time for throughput to climb back to its pre-cut level once power is restored. Lower is better.',
                    'valueKey' => 'recovery_delta_pct',
                    'improvesKey' => 'recovery_improves',
                    'suffix' => '%',
                    'improvedLabel' => 'faster recovery',
                    'worseLabel' => 'slower recovery',
                    'unitLabel' => 'time to recovery',
                    'secondary' => [
                        ['label' => 'Avg wait', 'key' => 'wait_delta_pct', 'suffix' => '%'],
                        ['label' => 'Throughput', 'key' => 'throughput_delta_pct', 'suffix' => '%'],
                    ],
                    // Same reasoning as the wait card's filter above - kept consistent even though
                    // throughput's own fixed-time baseline hasn't been observed to go unmeasured.
                    'filter' => fn ($c) => $c['power_state'] === 'load_shedding',
                    'recoveryPairMetric' => 'throughput',
                ],
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function buildPayload(?string $corridorFilter): array
    {
        $query = SimulationRun::query();
        if ($corridorFilter) {
            $query->where('corridor_config', $corridorFilter);
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
                'time_to_recovery_wait_seconds' => $run->time_to_recovery_wait_seconds,
                'time_to_recovery_wait_seconds_arterial' => $run->time_to_recovery_wait_seconds_arterial,
                'time_to_recovery_wait_seconds_side_street' => $run->time_to_recovery_wait_seconds_side_street,
            ])->all();

        return [
            'aggregates' => $aggregates,
            'aggregatesBySensor' => $aggregatesBySensor,
            'pairedComparisons' => $this->pairedComparisons($aggregates, $aggregatesBySensor),
            'recoveryTimeline' => $this->dbRecoveryTimeline($corridorFilter),
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
        foreach (self::SCOPED_METRICS as $metric) {
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

    /** Every scoped (Total/Arterial/Side-Streets) column of every metric in SCOPED_METRICS. */
    private function scopedMetricColumns(): array
    {
        $columns = [];
        foreach (self::SCOPED_METRICS as $metric) {
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
     * aggregatesBySensor(). The recovery and outage-segment metrics stay null-safe (no run in
     * the group measured a recovery/outage, e.g. all normal-power); avg_wait_time,
     * throughput_per_min, and pct_cleared_without_stop are never null on a populated row but a
     * legacy pre-migration row can still average to null (see the scope-columns migration's
     * docblock).
     *
     * @return array<string, float|null>
     */
    private function metricRow(object $row, array $stddevByColumn = []): array
    {
        $result = [];
        $runs = (int) $row->runs;
        foreach (self::SCOPED_METRICS as $metric) {
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
        // Two independent recovery clocks - see runHeadless.js's computeRecoverySeconds(): one
        // measures throughput climbing back to baseline, the other wait time dropping back to
        // it. Neither implies the other (a controller can restore flow volume quickly while
        // individual cars still wait longer than before, or vice versa).
        $recoveryKey = 'time_to_recovery_seconds'.$suffix;
        $recoveryWaitKey = 'time_to_recovery_wait_seconds'.$suffix;

        // Every metric can be null here, not just recovery: a group made up entirely of
        // pre-scope-migration rows averages to null on every `_arterial`/`_side_street`
        // column (see the scope-columns migration's docblock) until fresh data replaces it.
        $waitKnown = $subject[$waitKey] !== null && $baseline[$waitKey] !== null;
        $throughputKnown = $subject[$throughputKey] !== null && $baseline[$throughputKey] !== null;
        $clearedKnown = $subject[$clearedKey] !== null && $baseline[$clearedKey] !== null;
        $recoveryKnown = $subject[$recoveryKey] !== null && $baseline[$recoveryKey] !== null;
        $recoveryWaitKnown = $subject[$recoveryWaitKey] !== null && $baseline[$recoveryWaitKey] !== null;

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
            'recovery_wait_delta_pct' => $recoveryWaitKnown
                ? $this->pctChange($baseline[$recoveryWaitKey], $subject[$recoveryWaitKey])
                : null,
            'wait_improves' => $waitKnown ? $subject[$waitKey] < $baseline[$waitKey] : null,
            'throughput_improves' => $throughputKnown ? $subject[$throughputKey] > $baseline[$throughputKey] : null,
            'cleared_improves' => $clearedKnown ? $subject[$clearedKey] > $baseline[$clearedKey] : null,
            'recovery_improves' => $recoveryKnown
                ? $subject[$recoveryKey] < $baseline[$recoveryKey]
                : null,
            'recovery_wait_improves' => $recoveryWaitKnown
                ? $subject[$recoveryWaitKey] < $baseline[$recoveryWaitKey]
                : null,
            // Recovery time on its own only measures how long a metric takes to sustain its way
            // back to baseline - it says nothing about where things settle afterwards. A shorter
            // recovery time next to a worse steady-state (or vice versa) is a real, common
            // pattern here (e.g. a controller with a much lower pre-outage baseline has further,
            // proportionally, to climb back before it counts as "recovered"), so always render
            // this raw seconds value paired with the matching post-recovery segment average
            // rather than alone - see the results-page audit.
            //
            // Deliberately NOT gated behind $recoveryKnown/$recoveryWaitKnown (unlike the
            // percentage/improves fields above, which need BOTH sides to mean anything): a side
            // that measured null - most commonly fixed-time's own wait-time baseline, which
            // routinely never crosses the recovered threshold within the measured window on this
            // corridor - shouldn't also blank out the OTHER side's real, valid number. The view
            // renders each side independently (see $fmtRecoverySide in results.blade.php).
            'recovery_seconds' => $subject[$recoveryKey],
            'baseline_recovery_seconds' => $baseline[$recoveryKey],
            'recovery_wait_seconds' => $subject[$recoveryWaitKey],
            'baseline_recovery_wait_seconds' => $baseline[$recoveryWaitKey],
            'post_recovery_avg_wait' => $subject['avg_wait_time_post_recovery'.$suffix] ?? null,
            'baseline_post_recovery_avg_wait' => $baseline['avg_wait_time_post_recovery'.$suffix] ?? null,
            'post_recovery_throughput' => $subject['throughput_per_min_post_recovery'.$suffix] ?? null,
            'baseline_post_recovery_throughput' => $baseline['throughput_per_min_post_recovery'.$suffix] ?? null,
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
     * Per-tick throughput and avg wait, averaged across every load-shedding rep of a
     * (controller_mode, sensor_mode) condition - see SimulationRunRecoveryTick's
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
    private function dbRecoveryTimeline(?string $corridorFilter): ?array
    {
        $rows = SimulationRunRecoveryTick::query()
            ->when($corridorFilter, fn (Builder $q) => $q->where('corridor_config', $corridorFilter))
            ->orderBy('tick')
            ->get();
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
