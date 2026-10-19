<?php

namespace App\Http\Controllers;

use App\Enums\BatchKind;
use App\Enums\ControllerMode;
use App\Enums\PowerState;
use App\Enums\RoutingMode;
use App\Models\SimulationRun;
use App\Models\SimulationRunRecoveryTick;
use App\Models\TrafficCount;
use App\Support\ConfidenceInterval;
use App\Support\CoordinationMetrics;
use App\Support\CorridorRepository;
use App\Support\RoadWaitMetrics;
use App\Support\RoutingMetrics;
use App\Support\SeedPairedDeltas;
use App\Support\ZoneScopes;
use BackedEnum;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
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
    private const CONTROLLER_MODES = ['fixed', 'adaptive', 'green_wave', 'coordinated_adaptive'];

    /**
     * The column scopes of the results page's Scope filter - '' (unsuffixed columns) means Total, the rest suffix onto
     * every scoped metric column. The zone scopes (ZoneScopes::SUFFIXES) follow the same suffix convention but are read
     * from each run's zone_stats.
     */
    private const SCOPES = ['' => 'total', '_arterial' => 'arterial', '_side_street' => 'side_street'];

    private const SCOPE_LABELS = [
        'total' => 'Total (main + side streets)',
        'arterial' => 'Main arterial only',
        'side_street' => 'Side streets only',
        'zone1' => 'Zone 1 (south)',
        'zone2' => 'Zone 2 (middle)',
        'zone3' => 'Zone 3 (north)',
    ];

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
        // Rolling blackout only: its two stages, splitting the during-outage segment.
        'avg_wait_time_stage1',
        'avg_wait_time_stage2',
        'throughput_per_min_stage1',
        'throughput_per_min_stage2',
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

    /** The tail of the wait distribution, kept per scope too (`_arterial`/`_side_street`) - the median is Total only. */
    private const SCOPED_DISTRIBUTION_METRICS = ['p95_wait_time', 'max_wait_time'];

    /** Recovery metrics - a run that never recovers stores null, so each also gets a recovered-run count. */
    private const RECOVERY_METRICS = ['time_to_recovery_seconds', 'time_to_recovery_wait_seconds'];

    /** Fewest recovered runs a side needs before its mean recovery time is compared as a delta. */
    private const MIN_RECOVERED_RUNS = 10;

    /** Both sides recover within this - a % change on a few seconds reads as a big effect, so it's shown in seconds. */
    private const SHORT_RECOVERY_S = 30;

    public function __construct(
        private readonly CorridorRepository $corridors,
        private readonly SeedPairedDeltas $seedPairedDeltas,
        private readonly RoutingMetrics $routingMetrics,
        private readonly CoordinationMetrics $coordinationMetrics,
        private readonly RoadWaitMetrics $roadWaitMetrics,
        private readonly ZoneScopes $zoneScopes,
    ) {}

    public function index(): View
    {
        $routingMode = $this->routingModeFilter();
        $payload = $this->buildPayload(request()->query('corridor'), $routingMode);

        $corridors = $this->corridors->index();
        $trafficCounts = $this->trafficCountsForImport();

        return view('results', [
            'isFakeData' => $payload['totalRuns'] === 0,
            'corridors' => $corridors,
            'controllerModes' => self::CONTROLLER_MODES,
            'powerStates' => PowerState::values(),
            'scopeLabels' => self::SCOPE_LABELS,
            'trafficCounts' => $trafficCounts,
            'routingModes' => RoutingMode::cases(),
            'routingMode' => $routingMode,
            'chartPayload' => [
                'aggregates' => $payload['aggregates'],
                'aggregatesBySensor' => $payload['aggregatesBySensor'],
                'controllerModes' => self::CONTROLLER_MODES,
                'powerStates' => PowerState::values(),
                'powerLabels' => PowerState::options(),
                'scopeLabels' => self::SCOPE_LABELS,
                'recoveryTimeline' => $payload['recoveryTimeline'],
                'pairedComparisons' => $payload['pairedComparisons'],
                'minRecoveredRuns' => self::MIN_RECOVERED_RUNS,
                'batchWarmupLabel' => $payload['batchWarmupLabel'],
                'batchStamp' => $payload['batchStamp'],
                'hasNonStationaryBatch' => $payload['hasNonStationaryBatch'],
                'warmupDriftingLabel' => $payload['warmupDriftingLabel'],
                'lockupLabel' => $payload['lockupLabel'],
                'starvedLabel' => $payload['starvedLabel'],
                'routingMetrics' => $payload['routingMetrics'],
                'coordinationMetrics' => $payload['coordinationMetrics'],
                'roadWaits' => $payload['roadWaits'],
                'corridorUrlTemplate' => route('corridor-templates.show', ['corridor' => '__ID__']),
                // The user's own copy, only to warn in the run modal when it differs from the template the batch runs on.
                'savedLayoutUrlTemplate' => route('corridors.show', ['corridor' => '__ID__']),
                'resultsDataUrl' => route('results.data'),
                'latestBatchProgressUrl' => route('results.latest-batch-progress'),
                'defaultCorridorId' => $corridors[0]['id'] ?? null,
                'trafficCounts' => $trafficCounts,
            ],
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
        $payload = $this->buildPayload(request()->query('corridor'), $this->routingModeFilter());
        $viewData = [
            ...$payload,
            ...$this->viewModel($payload),
            'controllerModes' => self::CONTROLLER_MODES,
            'powerStates' => PowerState::values(),
        ];

        return response()->json([
            'aggregates' => $payload['aggregates'],
            'aggregatesBySensor' => $payload['aggregatesBySensor'],
            'controllerModes' => self::CONTROLLER_MODES,
            'powerStates' => PowerState::values(),
            'powerLabels' => PowerState::options(),
            'scopeLabels' => self::SCOPE_LABELS,
            'recoveryTimeline' => $payload['recoveryTimeline'],
            'pairedComparisons' => $payload['pairedComparisons'],
            'batchWarmupLabel' => $payload['batchWarmupLabel'],
            'batchStamp' => $payload['batchStamp'],
            'hasNonStationaryBatch' => $payload['hasNonStationaryBatch'],
            'warmupDriftingLabel' => $payload['warmupDriftingLabel'],
            'lockupLabel' => $payload['lockupLabel'],
            'starvedLabel' => $payload['starvedLabel'],
            'routingMetrics' => $payload['routingMetrics'],
            'coordinationMetrics' => $payload['coordinationMetrics'],
            'roadWaits' => $payload['roadWaits'],
            'html' => [
                'batchSummary' => trim(view('results.partials.batch-summary', $viewData)->render()),
                'researchQuestionCards' => view('results.partials.research-question-cards', $viewData)->render(),
                'metricSectionGroups' => view('results.partials.metric-section-groups', $viewData)->render(),
                'perConditionRows' => view('results.partials.per-condition-rows', $viewData)->render(),
                'segmentedRows' => view('results.partials.segmented-rows', $viewData)->render(),
                'recentRunsRows' => view('results.partials.recent-runs-rows', $viewData)->render(),
                'itsTargetOptions' => view('results.partials.its-target-options', $viewData)->render(),
                'routingMetrics' => view('results.partials.routing-metrics', $viewData)->render(),
            ],
        ]);
    }

    /**
     * Finished Traffic Counter uploads, for the batch modal's per-street "Import from
     * Traffic Counter" dropdown (Traffic Counter spec §10) - grouped by corridor+street
     * client-side in results.js, since the modal only shows the currently selected
     * corridor's rows. `fitted_mid`/`fitted_amplitude` are already computed by
     * ProcessTrafficCount (spec §6); nothing recomputed here.
     *
     * @return array<int, array<string, mixed>>
     */
    private function trafficCountsForImport(): array
    {
        return TrafficCount::query()
            ->where('status', 'done')
            ->latest()
            ->get(['id', 'label', 'corridor_config', 'street', 'fitted_mid', 'fitted_amplitude'])
            ->map(fn (TrafficCount $count) => [
                'id' => $count->id,
                'label' => $count->label ?? "Count #{$count->id}",
                'corridor_config' => $count->corridor_config,
                'street' => $count->street,
                'fitted_mid' => $count->fitted_mid,
                'fitted_amplitude' => $count->fitted_amplitude,
            ])
            ->all();
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
        $modeLabels = $this->modeLabels();
        $modeColours = collect(ControllerMode::cases())->mapWithKeys(fn (ControllerMode $mode): array => [$mode->value => $mode->colour()])->all();
        $powerLabels = PowerState::options();
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
        $scopeSuffixes = collect($this->scopes())->flip()->all();

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
        $fmtRecoverySide = fn (?float $v, int $recovered, int $runs) => ($v === null ? 'did not recover in window' : number_format($v, 1).'s')." ({$recovered}/{$runs} recovered)";

        $comparisonKey = fn (array $c) => $c['mode'].'|'.($c['sensor_mode'] ?? '');
        $comparisonLabel = function (array $c) use ($modeLabels, $sensorLabels) {
            if (! ControllerMode::from($c['mode'])->splitsBySensor()) {
                return $modeLabels[$c['mode']];
            }

            return $c['sensor_mode'] === 'average'
                ? "{$modeLabels[$c['mode']]} — avg. of sensors"
                : "{$modeLabels[$c['mode']]} — {$sensorLabels[$c['sensor_mode']]}";
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
            // Adaptive's average then its sensors, coordinated adaptive's the same, then the rest.
            $rank = function ($o) use ($sensorOrder) {
                $block = ['adaptive' => 0, 'coordinated_adaptive' => 10][$o['mode']] ?? null;
                if ($block === null) {
                    return 100;
                }

                return $block + ($o['sensor_mode'] === 'average' ? -1 : array_search($o['sensor_mode'], $sensorOrder, true));
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
            'outagePowerStates' => PowerState::outageValues(),
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
            'minRecoveredRuns' => self::MIN_RECOVERED_RUNS,
            'renderableMetricSectionGroups' => $this->metricSectionRenderGroups(
                $this->metricSectionGroupsConfig(),
                $payload['pairedComparisons']
            ),
        ];
    }

    /**
     * Card border colour for a subject-vs-baseline comparison - null means "not measured
     * yet" (neutral), true/false is an improvement/regression. Shared by the "vs
     * fixed-time" cards and the headline metric cards so both tone the same way.
     */
    /**
     * Whether the delta shown is an improvement - null (shown neutral) where there's none to show, or where the
     * seed-paired difference sits inside its own 95% CI: no winner to colour, e.g. "0.0% ±0.0" or "0.0% ±1.4".
     *
     * @param  array{delta: float, ci95: float, pairs: int}|null  $paired
     */
    private function improvesBeyondNoise(?float $delta, ?array $paired, bool $isLowerBetter): ?bool
    {
        if ($delta === null || $delta == 0.0) {
            return null;
        }
        if ($paired !== null && abs($paired['delta']) <= $paired['ci95']) {
            return null;
        }

        return $isLowerBetter ? $delta < 0 : $delta > 0;
    }

    private function toneClasses(?bool $improves): string
    {
        return match (true) {
            $improves === null => 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/40',
            $improves => 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-500/30 dark:bg-emerald-500/[0.06]',
            default => 'border-rose-300 bg-rose-50/70 dark:border-rose-500/30 dark:bg-rose-500/[0.06]',
        };
    }

    /** Headline-figure text colour, paired with {@see toneClasses()}'s border/background. */
    private function figureToneClasses(?bool $improves): string
    {
        return match (true) {
            $improves === null => 'text-slate-400 dark:text-slate-500',
            $improves => 'text-emerald-700 dark:text-emerald-300',
            default => 'text-rose-700 dark:text-rose-300',
        };
    }

    /**
     * Render-ready structure for metric-section-groups.blade.php - filtering sections down
     * to ones with rows, the resulting column counts, and each card's tone/value/recovery
     * derivations. Used to live as nested @php blocks in that partial; moved here so the
     * view stays presentation-only (project convention: no @php blocks in Blade).
     *
     * @param  array<int, array<int, array<string, mixed>>>  $metricSectionGroups
     * @param  array<int, array<string, mixed>>  $pairedComparisons
     * @return array<int, array{columns: int, sections: array<int, array<string, mixed>>}>
     */
    private function metricSectionRenderGroups(array $metricSectionGroups, array $pairedComparisons): array
    {
        $groups = [];

        foreach ($metricSectionGroups as $group) {
            $renderableSections = array_values(array_filter(
                array_map(
                    fn (array $section) => [
                        'section' => $section,
                        'rows' => array_values(array_filter($pairedComparisons, $section['filter'] ?? fn ($c) => true)),
                    ],
                    $group
                ),
                fn (array $entry) => count($entry['rows'])
            ));

            if (! count($renderableSections)) {
                continue;
            }

            $groups[] = [
                'columns' => count($renderableSections) > 1 ? 2 : 1,
                'sections' => array_map(
                    fn (array $entry) => $this->metricRenderSection($entry['section'], $entry['rows']),
                    $renderableSections
                ),
            ];
        }

        return $groups;
    }

    /**
     * @param  array<string, mixed>  $section
     * @param  array<int, array<string, mixed>>  $rows
     * @return array<string, mixed>
     */
    private function metricRenderSection(array $section, array $rows): array
    {
        $recoveryPairMetric = $section['recoveryPairMetric'] ?? null;

        return [
            'heading' => $section['heading'],
            'description' => $section['description'],
            'unitLabel' => $section['unitLabel'],
            'secondary' => $section['secondary'],
            // Cards visible AT ONCE, not count($rows) - see the original partial's comment on
            // why a recovery section (always load_shedding-only) stays a 1-visible-card grid.
            'visiblePowerStates' => count(array_unique(array_column($rows, 'power_state'))),
            'cards' => array_map(
                fn (array $comparison) => $this->metricRenderCard($section, $recoveryPairMetric, $comparison),
                $rows
            ),
        ];
    }

    /**
     * @param  array<string, mixed>  $section
     * @param  array<string, mixed>  $comparison
     * @return array<string, mixed>
     */
    private function metricRenderCard(array $section, ?string $recoveryPairMetric, array $comparison): array
    {
        $improves = $comparison[$section['improvesKey']];

        return [
            'comparison' => $comparison,
            'tone' => $this->toneClasses($improves),
            'figureTone' => $this->figureToneClasses($improves),
            'value' => $comparison[$section['valueKey']],
            'suffix' => $section['suffix'],
            'improves' => $improves,
            'isWithinNoise' => $improves === null && $comparison[$section['valueKey']] !== null,
            'recoveryDeltaSeconds' => $recoveryPairMetric === 'throughput' ? $comparison['recovery_delta_seconds'] : null,
            'improvedLabel' => $section['improvedLabel'],
            'worseLabel' => $section['worseLabel'],
            'recoveryPairMetric' => $recoveryPairMetric,
            // For the recovery cards, a null side usually means it never crossed the recovered
            // threshold within the measured window rather than a data gap - see
            // $fmtRecoverySide's comment above.
            'recoverySubjectSeconds' => match ($recoveryPairMetric) {
                'wait' => $comparison['recovery_wait_seconds'],
                'throughput' => $comparison['recovery_seconds'],
                default => null,
            },
            'recoveryBaselineSeconds' => match ($recoveryPairMetric) {
                'wait' => $comparison['baseline_recovery_wait_seconds'],
                'throughput' => $comparison['baseline_recovery_seconds'],
                default => null,
            },
            'recoverySubjectRecovered' => match ($recoveryPairMetric) {
                'wait' => $comparison['recovery_wait_recovered'],
                'throughput' => $comparison['recovery_recovered'],
                default => null,
            },
            'recoveryBaselineRecovered' => match ($recoveryPairMetric) {
                'wait' => $comparison['baseline_recovery_wait_recovered'],
                'throughput' => $comparison['baseline_recovery_recovered'],
                default => null,
            },
            'recoveryReliable' => match ($recoveryPairMetric) {
                'wait' => $comparison['recovery_wait_reliable'],
                'throughput' => $comparison['recovery_reliable'],
                default => true,
            },
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
                    'heading' => 'How fast does ITS recover from a blackout? - wait time',
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
                    'filter' => fn ($c) => PowerState::from($c['power_state'])->isOutage(),
                    // Recovery time alone can't be trusted (see $fmtSecondsPair's comment above) -
                    // this card always renders it next to the post-recovery steady-state wait.
                    'recoveryPairMetric' => 'wait',
                ],
                [
                    'heading' => 'How fast does ITS recover from a blackout? - throughput',
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
                    'filter' => fn ($c) => PowerState::from($c['power_state'])->isOutage(),
                    'recoveryPairMetric' => 'throughput',
                ],
            ],
        ];
    }

    /**
     * @return array<string, mixed>
     */
    /** Random turning and destination routing are separate datasets - the page shows one at a time. */
    /**
     * @return array<string, string>
     */
    private function modeLabels(): array
    {
        return collect(ControllerMode::cases())->mapWithKeys(fn (ControllerMode $mode): array => [$mode->value => $mode->label()])->all();
    }

    private function routingModeFilter(): RoutingMode
    {
        return RoutingMode::tryFrom((string) request()->query('routing')) ?? RoutingMode::Random;
    }

    private function buildPayload(?string $corridorFilter, RoutingMode $routingMode): array
    {
        $batchIds = $this->latestBatchIds($corridorFilter, $routingMode);
        $query = SimulationRun::query()->whereIn('batch_id', $batchIds);

        $aggregates = $this->aggregates((clone $query));
        $aggregatesBySensor = $this->aggregatesBySensor((clone $query));
        $recentRuns = (clone $query)->latest('created_at')->limit(10)->get()
            ->map(fn (SimulationRun $run) => [
                'id' => $run->id,
                'seed' => $run->seed,
                'controller_mode' => $run->controller_mode,
                'power_state' => $run->power_state->value,
                'sensor_mode' => $run->sensor_mode,
                'sensor_spec_set' => $run->sensor_spec_set,
                'sensor_spec_hash' => $run->sensor_spec_hash,
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
            'pairedComparisons' => $this->pairedComparisons($aggregates, $aggregatesBySensor, $this->seedPairedDeltas->forBatches($batchIds)),
            'recoveryTimeline' => $this->dbRecoveryTimeline($corridorFilter, $routingMode),
            'recentRuns' => $recentRuns,
            'totalRuns' => (clone $query)->count(),
            'batchTimingLabel' => $this->batchTimingLabel((clone $query)),
            'batchWarmupLabel' => $this->warmupLabel((clone $query)->whereNotNull('warmup_ticks')->distinct()->pluck('warmup_ticks')),
            'batchStamp' => $this->batchStamp((clone $query)),
            'hasNonStationaryBatch' => (clone $query)->where('warmup_stationary', false)->exists(),
            'warmupDriftingLabel' => $this->warmupDriftingLabel((clone $query)),
            'lockupLabel' => $this->lockupLabel((clone $query)),
            'starvedLabel' => $this->starvedLabel((clone $query)),
            'routingMetrics' => $this->routingMetrics->forBatches($batchIds),
            // Coordinated adaptive's own record, with its paired difference against adaptive alongside the vs-fixed-time ones.
            'coordinationMetrics' => [...$this->coordinationMetrics->forBatches($batchIds), 'versus_adaptive' => $this->seedPairedDeltas->versusAdaptive($batchIds)],
            'roadWaits' => $this->roadWaitMetrics->forBatches($batchIds),
        ];
    }

    /**
     * The probed warm-up(s) of the batches shown, e.g. "38 min" or "6-38 min" across corridors.
     *
     * @param  Collection<int, int>  $warmupTicks
     */
    private function warmupLabel(Collection $warmupTicks): ?string
    {
        if ($warmupTicks->isEmpty()) {
            return null;
        }

        // Batches run at dt = 0.1 s: 600 ticks a simulated minute.
        $minutes = $warmupTicks->map(fn (int $ticks) => (int) round($ticks / 600))->unique()->sort()->values();

        return $minutes->count() === 1 ? "{$minutes->first()} min" : "{$minutes->first()}-{$minutes->last()} min";
    }

    /**
     * When the most recently finished batch shown ran, e.g. "last batch (hatfield-realistic)
     * 25 Sep 2026, 23:05 -> 23:14 (9 min)". Its start is when it was launched, warm-up probe
     * included; legacy batches never stored one, so they only get their finish time.
     */
    private function batchTimingLabel(Builder $query): ?string
    {
        $latest = $query->toBase()
            ->selectRaw('corridor_config, min(batch_started_at) as started_at, min(created_at) as first_saved_at, max(created_at) as finished_at')
            ->groupBy('batch_id', 'corridor_config')
            ->orderByDesc('finished_at')
            ->first();

        if ($latest === null) {
            return null;
        }

        $finishedAt = Carbon::parse($latest->finished_at, 'UTC');
        $finishedLocal = $finishedAt->copy()->setTimezone(config('app.display_timezone'))->format('H:i');
        // No launch time stored: the span its runs were saved over is the best there is (it misses the probe and the first POST's runs).
        if ($latest->started_at === null) {
            return "last batch ({$latest->corridor_config}) runs saved {$this->displayTime($latest->first_saved_at)} → {$finishedLocal}";
        }

        $startedAt = Carbon::parse($latest->started_at, 'UTC');
        $minutes = max(1, (int) round($startedAt->diffInMinutes($finishedAt, true)));

        return "last batch ({$latest->corridor_config}) {$this->displayTime($latest->started_at)} → {$finishedLocal} ({$minutes} min)";
    }

    /**
     * What the newest batch shown ran: code (commit, dirty tree), wait accounting, routing, timing
     * and seeds - from the run config every run stores. Null fields for batches from before stamping.
     *
     * @param  Builder<SimulationRun>  $query
     * @return array<string, mixed>|null
     */
    /**
     * The runs the lockup watch (sim/lockupWatch.js) flagged, e.g. "Adaptive (camera), total blackout, seed 20270104 at
     * south_hilda" - null when none did, or the batch predates the watch.
     *
     * @param  Builder<SimulationRun>  $query
     */
    private function lockupLabel(Builder $query): ?string
    {
        $lockedRuns = $query->where('diagnostics->lockup->isLockup', true)->orderBy('id')->get(['controller_mode', 'sensor_mode', 'power_state', 'seed', 'diagnostics']);

        return $this->flaggedRunsLabel($lockedRuns, function (array $lockup): string {
            if (isset($lockup['firstCycle'])) {
                return implode(', ', $lockup['firstCycle']['nodeIds']);
            }

            // Batches from before the watch split locked from starved only have the longest standstill.
            return $lockup['locked']['nodeId'] ?? $lockup['longestStill']['nodeId'] ?? 'unknown junction';
        });
    }

    /**
     * The runs where a vehicle stood for minutes behind a queue that still moved - saturation the lockup watch reports
     * but doesn't fail the batch on, e.g. "Green wave, total blackout, seed 20270129 at lynnwood_herold (518 s)".
     *
     * @param  Builder<SimulationRun>  $query
     */
    private function starvedLabel(Builder $query): ?string
    {
        $starvedRuns = $query->where('diagnostics->lockup->isLockup', false)
            ->whereNotNull('diagnostics->lockup->starved')
            ->orderBy('id')
            ->get(['controller_mode', 'sensor_mode', 'power_state', 'seed', 'diagnostics']);

        return $this->flaggedRunsLabel($starvedRuns, fn (array $lockup): string => "{$lockup['starved']['nodeId']} ({$lockup['starved']['seconds']} s)");
    }

    /**
     * @param  Collection<int, SimulationRun>  $runs
     * @param  callable(array): string  $where  the junction(s) a run's lockup record points at
     */
    private function flaggedRunsLabel(Collection $runs, callable $where): ?string
    {
        if ($runs->isEmpty()) {
            return null;
        }

        $modeLabels = $this->modeLabels();
        $shown = 5;
        $label = $runs->take($shown)->map(function (SimulationRun $run) use ($modeLabels, $where): string {
            $sensor = ControllerMode::from($run->controller_mode)->splitsBySensor() ? " ({$run->sensor_mode})" : '';

            return sprintf('%s%s, %s, seed %d at %s', $modeLabels[$run->controller_mode] ?? $run->controller_mode, $sensor, strtolower($run->power_state->label()), $run->seed, $where($run->diagnostics['lockup']));
        })->join('; ');

        return $runs->count() > $shown ? "{$label}; and ".($runs->count() - $shown).' more' : $label;
    }

    /**
     * Which controller kept a batch from settling, from its warm-up probe, e.g. "Green wave (total +63%, side streets +82%)".
     * Null when every controller levelled off, or the batch predates the probe recording it.
     */
    private function warmupDriftingLabel(Builder $query): ?string
    {
        $drifting = $query->whereNotNull('warmup_drifting')->latest('id')->value('warmup_drifting');
        if (empty($drifting)) {
            return null;
        }

        $modeLabels = $this->modeLabels();
        $scopeLabels = ['total' => 'total', 'arterial' => 'main arterial', 'sideStreet' => 'side streets'];

        return collect($drifting)
            ->map(fn (array $probe) => sprintf(
                '%s (%s)',
                $modeLabels[$probe['controllerMode']] ?? $probe['controllerMode'],
                collect($probe['scopes'])->map(fn (int $driftPct, string $scope) => sprintf('%s +%d%%', $scopeLabels[$scope] ?? $scope, $driftPct))->join(', '),
            ))
            ->join('; ');
    }

    /**
     * The load-shedding ablation arms (batch/ablationArms.mjs) a batch's coordinated runs had on - null when none.
     *
     * @param  array<string, mixed>|null  $coordination
     */
    private function ablationLabel(?array $coordination): ?string
    {
        $zones = fn (array $ids): string => 'zone '.implode('+', $ids);
        $arms = collect([
            ! empty($coordination['recoveryHoldThroughOutageZones']) ? "A1 resync hold through the outage ({$zones($coordination['recoveryHoldThroughOutageZones'])})" : null,
            ! empty($coordination['freeCycleZones']) ? "A2 free cycle while another zone is dark ({$zones($coordination['freeCycleZones'])})" : null,
            ($coordination['connectorRouteMarriage'] ?? true) === false ? 'A3 Jan Shoba route marriage off' : null,
            ! empty($coordination['noPlatoonMessageZones']) ? "A4 platoon messages off while another zone is dark ({$zones($coordination['noPlatoonMessageZones'])})" : null,
        ])->filter();

        return $arms->isEmpty() ? null : 'ablation '.$arms->implode(', ');
    }

    /**
     * How the batch's coordinated junctions restarted when power came back: on the arterial green (restartOnArterialGreen,
     * the default since 2026-10-18 - the A5 arm before that) or part-way into the background plan (the legacy restart,
     * which runs from before the flag existed used).
     *
     * @param  array<string, mixed>|null  $coordination
     */
    private function restartLabel(?array $coordination): ?string
    {
        if ($coordination === null) {
            return null;
        }
        if (array_key_exists('restartOnArterialGreen', $coordination)) {
            return $coordination['restartOnArterialGreen'] ? 'coordinated restart on the arterial green' : 'coordinated restart mid-plan (legacy)';
        }

        return ! empty($coordination['holdStartsLikeAdaptive']) ? 'coordinated restart on the arterial green (ablation A5)' : 'coordinated restart mid-plan (legacy)';
    }

    /**
     * The sensor configurations a batch's actuated runs resolved to: spec set(s) and, per sensor, the resolved-spec hash.
     * Runs from before this was recorded carry none - reported as not recorded, never assumed.
     */
    private function sensorSpecs(string $batchId): array
    {
        $configs = SimulationRun::query()
            ->where('batch_id', $batchId)
            ->whereIn('controller_mode', [ControllerMode::Adaptive->value, ControllerMode::CoordinatedAdaptive->value])
            ->distinct()
            ->get(['sensor_mode', 'sensor_spec_set', 'sensor_spec_hash']);
        $recorded = $configs->whereNotNull('sensor_spec_set');
        if ($configs->isEmpty()) {
            return ['label' => null, 'sets' => [], 'hashes' => []];
        }
        if ($recorded->isEmpty()) {
            return ['label' => 'sensor specs not recorded', 'sets' => [], 'hashes' => []];
        }

        $sets = $recorded->pluck('sensor_spec_set')->unique()->values()->all();
        $partly = $recorded->count() < $configs->count() ? ', partly not recorded' : '';

        return [
            'label' => 'sensor specs '.implode('+', $sets).$partly,
            'sets' => $sets,
            'hashes' => $recorded->mapWithKeys(fn (SimulationRun $run) => [$run->sensor_mode => $run->sensor_spec_hash])->all(),
        ];
    }

    /**
     * Whether the batch's code had uncommitted changes - only 'clean' when a check said so. A dev-server stamp without
     * `fresh` predates the check at batch start (results.js's currentBuildStamp()); dirty null means git couldn't say.
     */
    private function treeState(array $build): ?string
    {
        return match (true) {
            ! isset($build['commit']) => null,
            ($build['source'] ?? null) === 'vite-dev' && ($build['fresh'] ?? false) !== true => 'unchecked',
            ! array_key_exists('dirty', $build) || $build['dirty'] === null => 'unknown',
            (bool) $build['dirty'] => 'dirty',
            default => 'clean',
        };
    }

    private function batchStamp(Builder $query): ?array
    {
        $latest = (clone $query)->latest('id')->first();
        if ($latest === null) {
            return null;
        }

        $config = $latest->raw_config_json ?? [];
        $build = $config['build'] ?? [];
        $seeds = SimulationRun::query()
            ->where('batch_id', $latest->batch_id)
            ->selectRaw('min(seed) as first_seed, max(seed) as last_seed')
            ->first();
        // Per power state: before 2026-10-16 the total blackout ran on its own +10000 seed set, so the report states what each batch actually used.
        $seedsByPower = SimulationRun::query()
            ->where('batch_id', $latest->batch_id)
            ->selectRaw('power_state, min(seed) as first_seed, max(seed) as last_seed')
            ->groupBy('power_state')
            ->get()
            ->mapWithKeys(fn (SimulationRun $run): array => [$run->power_state->value => ['first' => (int) $run->first_seed, 'last' => (int) $run->last_seed]]);
        $minutes = fn (?int $ticks): ?int => $ticks === null ? null : (int) round($ticks * ($config['dt'] ?? 0.1) / 60);

        $treeState = $this->treeState($build);
        $commit = match ($treeState) {
            null => 'commit not recorded',
            'unchecked' => "{$build['commit']} (tree state not checked)",
            'unknown' => "{$build['commit']} (tree state unknown)",
            'dirty' => "{$build['commit']} (uncommitted changes)",
            'clean' => "{$build['commit']} (clean tree)",
        };
        $buildSource = collect([
            ['vite-dev' => 'via dev server', 'vite-build' => 'via built bundle', 'cli' => 'via CLI'][$build['source'] ?? ''] ?? null,
            isset($build['sim']) ? "sim {$build['sim']}" : null,
        ])->filter()->implode(', ');
        $coordination = SimulationRun::query()
            ->where('batch_id', $latest->batch_id)
            ->where('controller_mode', 'coordinated_adaptive')
            ->first(['raw_config_json'])?->raw_config_json['controllerConfig']['coordination'] ?? null;
        $controllers = $config['controllerConfig'] ?? null;
        $controllerLabel = $controllers === null
            ? 'signal rules not recorded'
            : "Webster on {$controllers['websterTurnInput']}, turn weight on {$controllers['turnWeightActsOn']}, min green {$controllers['minGreenS']}/{$controllers['minTurnGreenS']} s";
        // Normal-power runs store no outage, so read the schedule off one of the batch's load-shedding runs.
        $outageConfig = SimulationRun::query()
            ->where('batch_id', $latest->batch_id)
            ->where('power_state', 'load_shedding')
            ->first(['raw_config_json'])?->raw_config_json ?? [];
        $outageEndTicks = $outageConfig['powerOutageEndTick'] ?? null;
        $waitAccounting = $config['waitAccounting'] ?? 'turn-reset (pre-2026-10-04)';
        $sensorSpecs = $this->sensorSpecs($latest->batch_id);

        return [
            'label' => collect([
                $buildSource === '' ? "code {$commit}" : "code {$commit} {$buildSource}",
                "wait accounting {$waitAccounting}",
                isset($config['zoneAccounting']) ? "zone wait {$config['zoneAccounting']}" : null,
                $controllerLabel,
                $sensorSpecs['label'],
                isset($coordination['crossShiftS']) ? "coordinated cross shift {$coordination['crossShiftS']} s" : null,
                $this->restartLabel($coordination),
                $this->ablationLabel($coordination),
                RoutingMode::tryFrom((string) $latest->routing_mode)?->label(),
                isset($config['routingTiersHash']) && $latest->routing_mode === RoutingMode::Destination->value ? "tiers {$config['routingTiersHash']}" : null,
                $seeds ? "seeds {$seeds->first_seed}-{$seeds->last_seed}" : null,
            ])->filter()->implode(' · '),
            'commit' => $build['commit'] ?? null,
            'dirty' => $build['dirty'] ?? null,
            'source' => $build['source'] ?? null,
            'sim' => $build['sim'] ?? null,
            'treeState' => $treeState,
            'waitAccounting' => $waitAccounting,
            'routingMode' => $latest->routing_mode,
            'warmupMinutes' => $minutes($config['warmupTicks'] ?? null),
            'warmupSettleMinutes' => $this->warmupSettleMinutes($config),
            'measuredMinutes' => $minutes($config['durationTicks'] ?? null),
            'outageStartMinutes' => $minutes($outageConfig['powerOutageStartTick'] ?? null),
            'outageEndMinutes' => $minutes($outageEndTicks),
            'firstSeed' => $seeds?->first_seed,
            'lastSeed' => $seeds?->last_seed,
            'seedsByPower' => $seedsByPower->isEmpty() ? null : $seedsByPower->all(),
            'startedAt' => $latest->batch_started_at?->toIso8601String(),
            // Seconds from power back on to the end of the measured window - a wait recovery that never happened is capped at this.
            'postRestoreWindowS' => $outageEndTicks === null || ! isset($config['durationTicks'])
                ? null
                : round(($config['durationTicks'] - $outageEndTicks) * ($config['dt'] ?? 0.1)),
            ...$this->outageWindows($latest->batch_id),
            'zoneAccounting' => $config['zoneAccounting'] ?? null,
            'controllerConfig' => $controllers,
            'sensorSpecs' => $sensorSpecs,
            // The coordination layers and thresholds the batch's coordinated adaptive runs used (marriage gates, platoon, tuning, levers).
            'coordination' => $coordination,
            'routingTiersHash' => $config['routingTiersHash'] ?? null,
        ];
    }

    /**
     * Per probed controller, when each scope's wait levelled off in the warm-up probe, in minutes from empty - null
     * where it never did. Null for a batch from before the probe recorded it.
     *
     * @return array<string, array<string, float|null>>|null
     */
    private function warmupSettleMinutes(array $config): ?array
    {
        if (! isset($config['warmupSettle'])) {
            return null;
        }
        $dt = $config['dt'] ?? 0.1;

        return collect($config['warmupSettle'])
            ->map(fn (array $scopes): array => collect($scopes)->map(fn (?int $tick): ?float => $tick === null ? null : round($tick * $dt / 60, 1))->all())
            ->all();
    }

    /** A stored (UTC) timestamp in the zone people read it in, e.g. "25 Sep 2026, 11:42". */
    private function displayTime(?string $utcTimestamp): ?string
    {
        return $utcTimestamp === null
            ? null
            : Carbon::parse($utcTimestamp, 'UTC')->setTimezone(config('app.display_timezone'))->format('j M Y, H:i');
    }

    /**
     * Each corridor's most recent batch - older batches were produced by earlier engine
     * versions, so pooling them would blend incomparable runs. They stay in the table.
     *
     * @return Collection<int, string>
     */
    private function latestBatchIds(?string $corridorFilter, RoutingMode $routingMode): Collection
    {
        $latestRunIds = SimulationRun::query()
            ->where('routing_mode', $routingMode->value)
            ->where('batch_kind', BatchKind::Main->value)
            ->when($corridorFilter, fn (Builder $query) => $query->where('corridor_config', $corridorFilter))
            ->selectRaw('max(id)')
            ->groupBy('corridor_config');

        return SimulationRun::query()->whereIn('id', $latestRunIds)->pluck('batch_id');
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
        $groupStats = $this->conditionGroupStats((clone $query), ['controller_mode', 'power_state']);

        return $query
            ->selectRaw('controller_mode, power_state, count(*) as runs, '.$this->metricSelectRaw())
            ->groupBy('controller_mode', 'power_state')
            ->get()
            ->map(fn ($row) => [
                'controller_mode' => $row->controller_mode,
                'power_state' => $row->power_state->value,
                'runs' => (int) $row->runs,
                ...$this->metricRow($row, $groupStats["{$row->controller_mode}|{$row->power_state->value}"]['ci95'] ?? []),
                ...$groupStats["{$row->controller_mode}|{$row->power_state->value}"]['zones'] ?? [],
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
        foreach (self::SCOPED_DISTRIBUTION_METRICS as $metric) {
            foreach (['_arterial', '_side_street'] as $suffix) {
                $clauses[] = "avg({$metric}{$suffix}) as {$metric}{$suffix}";
            }
        }
        // max_wait_time above is the mean of each run's own max - this is the single worst wait in any run.
        foreach (array_keys(self::SCOPES) as $suffix) {
            $clauses[] = "max(max_wait_time{$suffix}) as worst_wait_time{$suffix}";
        }
        foreach (self::RECOVERY_METRICS as $metric) {
            foreach (array_keys(self::SCOPES) as $suffix) {
                $column = $metric.$suffix;
                $clauses[] = "count({$column}) as {$column}_recovered";
            }
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
     * 95% CI half-width on each group's own mean - with 30 seeded reps per condition this is
     * what lets a viewer tell a small delta (e.g. +2.6%) apart from noise. A per-condition
     * figure, not a CI on the delta itself (that is SeedPairedDeltas).
     *
     * The samples are per-seed means, not runs: the adaptive average row has one run per sensor
     * on each seed, and those four share the seed's demand, so treating them as 120 independent
     * runs mixed between-sensor spread into the stddev and divided it by sqrt(120). Every other
     * group has one run per seed, where this is the plain per-run figure.
     *
     * Computed in PHP rather than SQL: the dev/test DB is SQLite, which has no STDDEV_SAMP. The zone scopes' own means
     * (and recovered counts) are built here too, from each run's zone_stats - they have no column to average in SQL.
     *
     * @param  Builder<SimulationRun>  $query
     * @param  array<int, string>  $groupColumns
     * @return array<string, array{ci95: array<string, float|null>, zones: array<string, float|int|null>}> group key -> ci95 per column, zone fields
     */
    private function conditionGroupStats(Builder $query, array $groupColumns): array
    {
        $metricColumns = [...$this->scopedMetricColumns(), ...$this->zoneMetricColumns()];

        return $query->select([...$groupColumns, 'corridor_config', 'seed', 'zone_stats', ...$this->scopedMetricColumns()])
            ->get()
            ->toBase()
            ->groupBy(fn (SimulationRun $run): string => collect($groupColumns)->map(fn (string $column): string => $this->groupValue($run->{$column}))->implode('|'))
            ->map(function (Collection $groupRuns) use ($metricColumns): array {
                // A group from before zones has nothing to build the zone intervals from.
                $hasZoneStats = $groupRuns->contains(fn (SimulationRun $run): bool => $run->zone_stats !== null);
                $ci95s = collect($metricColumns)->mapWithKeys(fn (string $column): array => [
                    $column => $hasZoneStats || ! $this->zoneScopes->isZoneColumn($column) ? $this->ci95OnSeedMeans($groupRuns, $column) : null,
                ]);
                $zoneCi95s = $ci95s->only($this->zoneMetricColumns())
                    ->mapWithKeys(fn (?float $ci95, string $column): array => ["{$column}_ci95" => $ci95]);

                return ['ci95' => $ci95s->all(), 'zones' => [...$this->zoneMetricRow($groupRuns), ...$zoneCi95s->all()]];
            })
            ->all();
    }

    private function groupValue(mixed $value): string
    {
        return $value instanceof BackedEnum ? (string) $value->value : (string) ($value ?? '');
    }

    /** Every zone column an aggregate row carries - the column scopes' metrics plus the full wait distribution. */
    private function zoneMetricColumns(): array
    {
        return $this->zoneScopes->columns([...self::SCOPED_METRICS, ...self::TOTAL_ONLY_METRICS]);
    }

    /**
     * A group's zone fields, named like the column scopes' (`avg_wait_time_zone1`, `..._recovered`, `worst_wait_time_zone1`),
     * plus each zone's restore second and post-restore window (`restore_seconds_zone1`, `post_restore_window_s_zone1`).
     *
     * @param  Collection<int, SimulationRun>  $runs
     * @return array<string, float|int|null>
     */
    private function zoneMetricRow(Collection $runs): array
    {
        $values = fn (string $column): Collection => $runs->map(fn (SimulationRun $run): ?float => $this->zoneScopes->value($run, $column))
            ->filter(fn (?float $value): bool => $value !== null);
        $mean = function (string $column) use ($values): ?float {
            $present = $values($column);

            return $present->isEmpty() ? null : round($present->avg(), 1);
        };

        $row = collect($this->zoneMetricColumns())->mapWithKeys(fn (string $column): array => [$column => $mean($column)]);
        foreach (array_keys(ZoneScopes::SUFFIXES) as $suffix) {
            $worst = $values("max_wait_time{$suffix}")->max();
            $row["worst_wait_time{$suffix}"] = $worst === null ? null : round($worst, 1);
            $row["restore_seconds{$suffix}"] = $mean("restore_seconds{$suffix}");
            $row["post_restore_window_s{$suffix}"] = $mean("post_restore_window_s{$suffix}");
            foreach (self::RECOVERY_METRICS as $metric) {
                $row["{$metric}{$suffix}_recovered"] = $values($metric.$suffix)->count();
            }
        }

        return $row->all();
    }

    /** A column's value on a run - a zone column from its zone_stats. */
    private function runValue(SimulationRun $run, string $column): ?float
    {
        if ($this->zoneScopes->isZoneColumn($column)) {
            return $this->zoneScopes->value($run, $column);
        }

        return $run->{$column} === null ? null : (float) $run->{$column};
    }

    /** @param  Collection<int, SimulationRun>  $runs */
    private function ci95OnSeedMeans(Collection $runs, string $column): ?float
    {
        $seedMeans = $runs->filter(fn (SimulationRun $run): bool => $this->runValue($run, $column) !== null)
            ->groupBy(fn (SimulationRun $run): string => "{$run->corridor_config}|{$run->seed}")
            ->map(fn (Collection $seedRuns): float => (float) $seedRuns->avg(fn (SimulationRun $run): ?float => $this->runValue($run, $column)))
            ->values();

        $samples = $seedMeans->count();
        if ($samples < 2) {
            return null;
        }

        $mean = $seedMeans->avg();
        $variance = $seedMeans->sum(fn (float $value): float => ($value - $mean) ** 2) / ($samples - 1);

        return round(ConfidenceInterval::halfWidth95(sqrt($variance), $samples), 1);
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
    private function metricRow(object $row, array $ci95ByColumn = []): array
    {
        $result = [];
        foreach (self::SCOPED_METRICS as $metric) {
            foreach (array_keys(self::SCOPES) as $suffix) {
                $column = $metric.$suffix;
                $result[$column] = $row->$column === null ? null : round((float) $row->$column, 1);
                $result[$column.'_ci95'] = $ci95ByColumn[$column] ?? null;
            }
        }
        foreach (self::TOTAL_ONLY_METRICS as $column) {
            $result[$column] = $row->$column === null ? null : round((float) $row->$column, 1);
        }
        foreach (self::SCOPED_DISTRIBUTION_METRICS as $metric) {
            foreach (['_arterial', '_side_street'] as $suffix) {
                $column = $metric.$suffix;
                $result[$column] = $row->$column === null ? null : round((float) $row->$column, 1);
            }
        }
        foreach (array_keys(self::SCOPES) as $suffix) {
            $column = "worst_wait_time{$suffix}";
            $result[$column] = $row->$column === null ? null : round((float) $row->$column, 1);
        }
        // avg() skips runs that never recovered, so the mean alone hides how many it's built on.
        foreach (self::RECOVERY_METRICS as $metric) {
            foreach (array_keys(self::SCOPES) as $suffix) {
                $column = $metric.$suffix.'_recovered';
                $result[$column] = (int) $row->$column;
            }
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
        $groupStats = $this->conditionGroupStats((clone $query), ['controller_mode', 'power_state', 'sensor_mode']);

        return $query
            ->selectRaw('controller_mode, power_state, sensor_mode, count(*) as runs, '.$this->metricSelectRaw())
            ->groupBy('controller_mode', 'power_state', 'sensor_mode')
            ->get()
            ->map(fn ($row) => [
                'controller_mode' => $row->controller_mode,
                'power_state' => $row->power_state->value,
                'sensor_mode' => $row->sensor_mode,
                'runs' => (int) $row->runs,
                ...$this->metricRow($row, $groupStats["{$row->controller_mode}|{$row->power_state->value}|{$row->sensor_mode}"]['ci95'] ?? []),
                ...$groupStats["{$row->controller_mode}|{$row->power_state->value}|{$row->sensor_mode}"]['zones'] ?? [],
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
    private function pairedComparisons(array $aggregates, array $aggregatesBySensor, array $seedDeltas): array
    {
        $lookup = [];
        foreach ($aggregates as $row) {
            $lookup["{$row['controller_mode']}|{$row['power_state']}"] = $row;
        }

        $comparisons = [];

        foreach ($this->scopes() as $suffix => $scope) {
            foreach (['adaptive', 'green_wave', 'coordinated_adaptive'] as $mode) {
                foreach (PowerState::values() as $power) {
                    $subject = $lookup["{$mode}|{$power}"] ?? null;
                    $baseline = $lookup['fixed|'.$power] ?? null;
                    if (! $subject || ! $baseline) {
                        continue;
                    }

                    $splitsBySensor = ControllerMode::from($mode)->splitsBySensor();
                    $comparisons[] = $this->buildComparison(
                        $mode,
                        $splitsBySensor ? 'average' : null,
                        $power,
                        $scope,
                        $suffix,
                        $subject,
                        $baseline,
                        $seedDeltas[$splitsBySensor ? "{$mode}|average|{$power}" : "{$mode}||{$power}"] ?? []
                    );
                }
            }

            $sensorRows = collect($aggregatesBySensor)
                ->filter(fn (array $row): bool => $row['sensor_mode'] !== null && ControllerMode::from($row['controller_mode'])->splitsBySensor());

            foreach ($sensorRows as $subject) {
                ['controller_mode' => $mode, 'sensor_mode' => $sensor, 'power_state' => $power] = $subject;
                $baseline = $lookup['fixed|'.$power] ?? null;
                if (! $baseline) {
                    continue;
                }

                $comparisons[] = $this->buildComparison($mode, $sensor, $power, $scope, $suffix, $subject, $baseline, $seedDeltas["{$mode}|{$sensor}|{$power}"] ?? []);
            }
        }

        return $comparisons;
    }

    /**
     * @param  array<string, mixed>  $subject
     * @param  array<string, mixed>  $baseline
     * @param  array<string, array{delta: float, ci95: float, pairs: int}>  $paired  SeedPairedDeltas for this condition
     * @return array<string, mixed>
     */
    private function buildComparison(
        string $mode,
        ?string $sensorMode,
        string $power,
        string $scope,
        string $suffix,
        array $subject,
        array $baseline,
        array $paired
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
        // A recovery mean built on a handful of recovered runs isn't comparable as an effect
        // size - both sides need MIN_RECOVERED_RUNS before a delta is computed at all.
        $recoveryReliable = min($subject[$recoveryKey.'_recovered'], $baseline[$recoveryKey.'_recovered']) >= self::MIN_RECOVERED_RUNS;
        $recoveryWaitReliable = min($subject[$recoveryWaitKey.'_recovered'], $baseline[$recoveryWaitKey.'_recovered']) >= self::MIN_RECOVERED_RUNS;
        $recoveryKnown = $recoveryReliable && $subject[$recoveryKey] !== null && $baseline[$recoveryKey] !== null;
        $recoveryWaitKnown = $recoveryWaitReliable && $subject[$recoveryWaitKey] !== null && $baseline[$recoveryWaitKey] !== null;
        // A 0.0s baseline recovery (fixed-time recovered instantly) leaves no ratio to take -
        // pctChange() returns null there, and the improves flag follows so the cell isn't tinted.
        $recoveryDelta = $recoveryKnown ? $this->pctChange($baseline[$recoveryKey], $subject[$recoveryKey]) : null;
        $recoveryWaitDelta = $recoveryWaitKnown ? $this->pctChange($baseline[$recoveryWaitKey], $subject[$recoveryWaitKey]) : null;
        $waitDelta = $paired[$waitKey]['delta'] ?? ($waitKnown ? $this->pctChange($baseline[$waitKey], $subject[$waitKey]) : null);
        $throughputDelta = $paired[$throughputKey]['delta'] ?? ($throughputKnown ? $this->pctChange($baseline[$throughputKey], $subject[$throughputKey]) : null);
        $clearedDelta = $paired[$clearedKey]['delta'] ?? ($clearedKnown ? round($subject[$clearedKey] - $baseline[$clearedKey], 1) : null);
        $waitImproves = $this->improvesBeyondNoise($waitDelta, $paired[$waitKey] ?? null, isLowerBetter: true);
        $isShortRecovery = $recoveryKnown && max($subject[$recoveryKey], $baseline[$recoveryKey]) < self::SHORT_RECOVERY_S;

        return [
            'mode' => $mode,
            'sensor_mode' => $sensorMode,
            'baseline' => 'fixed',
            'power_state' => $power,
            'scope' => $scope,
            // Wait time: lower is better, so a negative delta is an improvement.
            // The exact paired delta where there is one - the condition means are rounded to 0.1 for display.
            'wait_delta_pct' => $waitDelta,
            'throughput_delta_pct' => $throughputDelta,
            'cleared_delta_pp' => $clearedDelta,
            // Recovery time: only meaningful under load shedding (null otherwise); lower is better.
            'recovery_delta_pct' => $recoveryDelta,
            'recovery_wait_delta_pct' => $recoveryWaitDelta,
            'wait_improves' => $waitImproves,
            'wait_tone' => $this->toneClasses($waitImproves),
            'wait_figure_tone' => $this->figureToneClasses($waitImproves),
            'throughput_improves' => $this->improvesBeyondNoise($throughputDelta, $paired[$throughputKey] ?? null, isLowerBetter: false),
            'cleared_improves' => $this->improvesBeyondNoise($clearedDelta, $paired[$clearedKey] ?? null, isLowerBetter: false),
            'recovery_improves' => $this->improvesBeyondNoise($recoveryDelta, $paired[$recoveryKey] ?? null, isLowerBetter: true),
            'recovery_wait_improves' => $this->improvesBeyondNoise($recoveryWaitDelta, $paired[$recoveryWaitKey] ?? null, isLowerBetter: true),
            'recovery_delta_seconds' => $isShortRecovery ? round($subject[$recoveryKey] - $baseline[$recoveryKey], 1) : null,
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
            'recovery_recovered' => $subject[$recoveryKey.'_recovered'],
            'baseline_recovery_recovered' => $baseline[$recoveryKey.'_recovered'],
            'recovery_wait_recovered' => $subject[$recoveryWaitKey.'_recovered'],
            'baseline_recovery_wait_recovered' => $baseline[$recoveryWaitKey.'_recovered'],
            'recovery_reliable' => $recoveryReliable,
            'recovery_wait_reliable' => $recoveryWaitReliable,
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
            // 95% CI half-width on the delta itself, from the per-seed differences (SeedPairedDeltas).
            'paired_seeds' => $paired[$waitKey]['pairs'] ?? null,
            'wait_delta_ci95_pct' => $paired[$waitKey]['ci95'] ?? null,
            'throughput_delta_ci95_pct' => $paired[$throughputKey]['ci95'] ?? null,
            'cleared_delta_ci95_pp' => $paired[$clearedKey]['ci95'] ?? null,
            'recovery_delta_ci95_pct' => $paired[$recoveryKey]['ci95'] ?? null,
            'recovery_wait_delta_ci95_pct' => $paired[$recoveryWaitKey]['ci95'] ?? null,
            // The tail next to the mean - stored for the total scope only.
            'median_wait_delta_pct' => $suffix === '' ? ($paired['median_wait_time']['delta'] ?? null) : null,
            'median_wait_delta_ci95_pct' => $suffix === '' ? ($paired['median_wait_time']['ci95'] ?? null) : null,
            'p95_wait_delta_pct' => $paired['p95_wait_time'.$suffix]['delta'] ?? null,
            'p95_wait_delta_ci95_pct' => $paired['p95_wait_time'.$suffix]['ci95'] ?? null,
            'max_wait_delta_pct' => $paired['max_wait_time'.$suffix]['delta'] ?? null,
            'max_wait_delta_ci95_pct' => $paired['max_wait_time'.$suffix]['ci95'] ?? null,
        ];
    }

    /**
     * Null when $from is zero: (x - 0) / 0 is undefined, and reporting it as 0.0% would read as
     * "no difference" - the view renders null as n/a instead.
     */
    private function pctChange(float $from, float $to): ?float
    {
        if ($from == 0.0) {
            return null;
        }

        return round((($to - $from) / $from) * 100, 1);
    }

    /**
     * Per-tick throughput and avg wait, averaged across every rep of an outage
     * (controller_mode, sensor_mode) condition - see SimulationRunRecoveryTick's
     * docblock. Keyed the same way as pairedComparisons()'s cards
     * (`"{mode}|{sensor_mode}"`, empty string for the two modes that never
     * vary by sensor) so results.js can look a series up directly by
     * whatever the "Compare against fixed-time" dropdown has selected.
     * One timeline per outage power state under `byPowerState`; the top level repeats the
     * total blackout's (the rolling blackout's when there is none) so older readers keep working.
     * Returns null until the batch runner has actually captured one - there
     * is no fallback to fake data here, an empty/missing chart is the honest
     * state before a run exists.
     *
     * @return array<string, mixed>|null
     */
    private function dbRecoveryTimeline(?string $corridorFilter, RoutingMode $routingMode): ?array
    {
        $rows = SimulationRunRecoveryTick::query()
            ->where('routing_mode', $routingMode->value)
            ->when($corridorFilter, fn (Builder $q) => $q->where('corridor_config', $corridorFilter))
            ->orderBy('tick')
            ->get();
        if ($rows->isEmpty()) {
            return null;
        }

        $byPowerState = collect(PowerState::outageValues())
            ->mapWithKeys(fn (string $power): array => [$power => $rows->filter(fn (SimulationRunRecoveryTick $row): bool => $row->power_state->value === $power)])
            ->filter(fn (Collection $powerRows): bool => $powerRows->isNotEmpty())
            ->map(fn (Collection $powerRows, string $power): array => $this->recoveryTimeline($powerRows, $power));

        return [
            ...$byPowerState->get(PowerState::LoadShedding->value) ?? $byPowerState->first(),
            'byPowerState' => $byPowerState->all(),
        ];
    }

    /**
     * One power state's curves.
     *
     * @param  Collection<int, SimulationRunRecoveryTick>  $rows
     * @return array{powerState: string, seconds: array<int, float>, series: array<string, array<string, array<int, ?float>>>, sheddingStart: ?float, sheddingEnd: ?float, darkWindows: array<int, array{zones: ?array<int, int>, fromS: float, toS: float}>}
     */
    private function recoveryTimeline(Collection $rows, string $power): array
    {
        $seconds = null;
        $series = [];
        $first = $rows->first();

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
        }

        $sheddingStart = round((float) $first->power_event_seconds, 1);
        // Power is actually restored at `sheddingEnd` (see runBatch.mjs/results.js's
        // outage schedule) - a legacy row captured before that existed has no restore
        // time on record, so its band falls back to "trigger to end of series" rather
        // than claiming a restore that was never simulated.
        $sheddingEnd = $first->power_outage_end_seconds === null ? end($seconds) : round((float) $first->power_outage_end_seconds, 1);

        return [
            'powerState' => $power,
            'seconds' => $seconds,
            'series' => $series,
            'sheddingStart' => $sheddingStart,
            'sheddingEnd' => $sheddingEnd,
            // Each dark window (zones null = every junction) - a curve from before these were stored was one total blackout.
            'darkWindows' => $first->dark_windows ?? [['zones' => null, 'fromS' => $sheddingStart, 'toS' => $sheddingEnd]],
        ];
    }

    /**
     * The Scope filter's scopes, suffix => scope: the column scopes, then the zones.
     *
     * @return array<string, string>
     */
    private function scopes(): array
    {
        return [...self::SCOPES, ...ZoneScopes::SUFFIXES];
    }

    /**
     * Each outage power state's dark windows and restores, read off one of the batch's runs of that state:
     * `rollingSchedule` (in measured seconds), and per power state and scope the restore second and the post-restore
     * window - each recovery's cap. Total/arterial/side are measured from the final restore, each zone from its own
     * (its zone_stats), falling back to the final restore for a run from before zones.
     *
     * @return array{rollingSchedule: ?array<int, array{zones: array<int, int>, fromS: float, toS: float}>, restoreSecondsByScope: array<string, array<string, ?float>>, postRestoreWindowSByScope: array<string, array<string, ?float>>}
     */
    private function outageWindows(string $batchId): array
    {
        $runs = collect(PowerState::outageValues())
            ->mapWithKeys(fn (string $power): array => [$power => SimulationRun::query()
                ->where('batch_id', $batchId)
                ->where('power_state', $power)
                ->first(['raw_config_json', 'zone_stats'])])
            ->filter();
        $seconds = fn (array $config, ?int $ticks): ?float => $ticks === null ? null : round($ticks * ($config['dt'] ?? 0.1), 1);

        $restores = $runs->map(function (SimulationRun $run) use ($seconds): array {
            $config = $run->raw_config_json ?? [];
            $finalRestoreTick = isset($config['rollingSchedule'])
                ? collect($config['rollingSchedule'])->max('toTick')
                : $config['powerOutageEndTick'] ?? null;
            $finalRestoreS = $seconds($config, $finalRestoreTick);
            $windowS = $finalRestoreTick === null || ! isset($config['durationTicks']) ? null : $seconds($config, $config['durationTicks'] - $finalRestoreTick);

            $restore = collect(self::SCOPES)->mapWithKeys(fn (string $scope): array => [$scope => [$finalRestoreS, $windowS]]);
            foreach (ZoneScopes::SUFFIXES as $zone) {
                $zoneStats = $run->zone_stats[$zone] ?? [];
                $restore[$zone] = [$zoneStats['restoreSeconds'] ?? $finalRestoreS, $zoneStats['postRestoreWindowS'] ?? $windowS];
            }

            return $restore->all();
        });

        $rollingConfig = $runs->get(PowerState::RollingBlackout->value)?->raw_config_json;

        return [
            'rollingSchedule' => isset($rollingConfig['rollingSchedule'])
                ? collect($rollingConfig['rollingSchedule'])->map(fn (array $window): array => [
                    'zones' => $window['zones'],
                    'fromS' => $seconds($rollingConfig, $window['fromTick']),
                    'toS' => $seconds($rollingConfig, $window['toTick']),
                ])->all()
                : null,
            'restoreSecondsByScope' => $restores->map(fn (array $scopes): array => collect($scopes)->map(fn (array $pair): ?float => $pair[0])->all())->all(),
            'postRestoreWindowSByScope' => $restores->map(fn (array $scopes): array => collect($scopes)->map(fn (array $pair): ?float => $pair[1])->all())->all(),
        ];
    }
}
