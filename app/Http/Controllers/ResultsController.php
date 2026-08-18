<?php

namespace App\Http\Controllers;

use App\Support\CorridorRepository;
use Illuminate\View\View;

/**
 * Results dashboard.
 *
 * PHASE 1: every number below is HARDCODED FAKE DATA. It exists so the chart
 * layout, the paired-comparison callouts and the run table can be designed and
 * reviewed before any real run exists to feed them.
 *
 * The arrays are shaped exactly like the Phase 2 queries will return, so build
 * step 22 is a data-source swap and nothing else:
 *
 *   $aggregates  <-  SimulationRun::query()
 *                       ->selectRaw('controller_mode, power_state, count(*) as runs,
 *                                    avg(avg_wait_time) as avg_wait_time,
 *                                    avg(throughput_per_min) as throughput_per_min,
 *                                    avg(pct_cleared_without_stop) as pct_cleared_without_stop,
 *                                    avg(time_to_recovery_seconds) as time_to_recovery_seconds')
 *                       ->groupBy('controller_mode', 'power_state')->get()
 *
 *   $recentRuns  <-  SimulationRun::latest()->limit(10)->get()
 *
 * `$pairedComparisons` and `$recoveryTimeline` are DERIVED from those, so that
 * arithmetic already survives the swap untouched.
 *
 * Caveat kept deliberately visible on the page: the recovery timeline is
 * per-tick data. `simulation_runs` stores one summary row per run (spec's DB
 * schema), so in Phase 2 that series comes from the batch runner's CSV output
 * under `results/`, not from MySQL.
 */
class ResultsController extends Controller
{
    private const CONTROLLER_MODES = ['fixed', 'adaptive', 'green_wave'];

    private const POWER_STATES = ['normal', 'load_shedding'];

    public function __construct(private readonly CorridorRepository $corridors) {}

    public function index(): View
    {
        $aggregates = $this->fakeAggregates();

        return view('results', [
            'isFakeData' => true,
            'corridors' => $this->corridors->index(),
            'controllerModes' => self::CONTROLLER_MODES,
            'powerStates' => self::POWER_STATES,
            'aggregates' => $aggregates,
            'pairedComparisons' => $this->pairedComparisons($aggregates),
            'recoveryTimeline' => $this->fakeRecoveryTimeline(),
            'recentRuns' => $this->fakeRecentRuns(),
            'totalRuns' => array_sum(array_column($aggregates, 'runs')),
        ]);
    }

    /**
     * One row per controller_mode x power_state - the shape of the real
     * groupBy aggregate. FAKE.
     *
     * @return array<int, array<string, mixed>>
     */
    private function fakeAggregates(): array
    {
        $canned = [
            // mode        power           wait   thru   cleared%  recovery(s)
            ['fixed', 'normal', 42.6, 38.2, 18.3, null],
            ['adaptive', 'normal', 31.4, 44.7, 31.7, null],
            ['green_wave', 'normal', 24.8, 47.9, 68.4, null],
            // Under load shedding the adaptive controller degrades FURTHER than
            // fixed-time: it loses the lights AND its decision input. That is the
            // dissertation's actual finding, so the fake data has to be able to
            // show it - a mock that only ever flatters ITS would hide the result
            // the charts exist to surface.
            ['fixed', 'load_shedding', 78.9, 21.4, 7.1, 96.4],
            ['adaptive', 'load_shedding', 86.2, 19.8, 6.4, 132.7],
            ['green_wave', 'load_shedding', 71.5, 22.6, 24.9, 118.2],
        ];

        return array_map(fn (array $row) => [
            'controller_mode' => $row[0],
            'power_state' => $row[1],
            'runs' => 30,
            'avg_wait_time' => $row[2],
            'throughput_per_min' => $row[3],
            'pct_cleared_without_stop' => $row[4],
            'time_to_recovery_seconds' => $row[5],
        ], $canned);
    }

    /**
     * The dissertation's research question, answered directly: each ITS mode
     * against the fixed-time baseline, separately under normal power and under
     * load shedding.
     *
     * @param  array<int, array<string, mixed>>  $aggregates
     * @return array<int, array<string, mixed>>
     */
    private function pairedComparisons(array $aggregates): array
    {
        $lookup = [];
        foreach ($aggregates as $row) {
            $lookup["{$row['controller_mode']}|{$row['power_state']}"] = $row;
        }

        $comparisons = [];

        foreach (['adaptive', 'green_wave'] as $mode) {
            foreach (self::POWER_STATES as $power) {
                $subject = $lookup["{$mode}|{$power}"] ?? null;
                $baseline = $lookup["fixed|{$power}"] ?? null;
                if (! $subject || ! $baseline) {
                    continue;
                }

                $comparisons[] = [
                    'mode' => $mode,
                    'baseline' => 'fixed',
                    'power_state' => $power,
                    // Wait time: lower is better, so a negative delta is an improvement.
                    'wait_delta_pct' => $this->pctChange($baseline['avg_wait_time'], $subject['avg_wait_time']),
                    'throughput_delta_pct' => $this->pctChange($baseline['throughput_per_min'], $subject['throughput_per_min']),
                    'cleared_delta_pp' => round($subject['pct_cleared_without_stop'] - $baseline['pct_cleared_without_stop'], 1),
                    'wait_improves' => $subject['avg_wait_time'] < $baseline['avg_wait_time'],
                ];
            }
        }

        return $comparisons;
    }

    private function pctChange(float $from, float $to): float
    {
        if ($from == 0.0) {
            return 0.0;
        }

        return round((($to - $from) / $from) * 100, 1);
    }

    /**
     * Average wait over a 300 s run with a power cut from t=120 s to t=240 s.
     * FAKE, and generated rather than typed out so the shape stays readable.
     *
     * @return array<string, mixed>
     */
    private function fakeRecoveryTimeline(): array
    {
        $sheddingStart = 120;
        $sheddingEnd = 240;
        $seconds = range(0, 300, 15);

        // [steady state, load-shed peak, recovery half-life in seconds]
        $profiles = [
            'fixed' => [42.6, 79.0, 34],
            'adaptive' => [31.4, 86.0, 52],
            'green_wave' => [24.8, 71.5, 46],
        ];

        $series = [];
        foreach ($profiles as $mode => [$steady, $peak, $halfLife]) {
            $points = [];
            foreach ($seconds as $t) {
                if ($t < $sheddingStart) {
                    // Small deterministic ripple so a flat line does not read as "no data".
                    $value = $steady + sin($t / 22) * ($steady * 0.04);
                } elseif ($t <= $sheddingEnd) {
                    // Queues build toward the degraded peak while the lights are dark.
                    $progress = min(1.0, ($t - $sheddingStart) / 90);
                    $value = $steady + ($peak - $steady) * $progress;
                } else {
                    // Exponential decay back toward steady state once power returns.
                    $value = $steady + ($peak - $steady) * 2 ** (-($t - $sheddingEnd) / $halfLife);
                }
                $points[] = round($value, 1);
            }
            $series[$mode] = $points;
        }

        return [
            'seconds' => $seconds,
            'series' => $series,
            'sheddingStart' => $sheddingStart,
            'sheddingEnd' => $sheddingEnd,
        ];
    }

    /**
     * Stand-in for `SimulationRun::latest()`. FAKE.
     *
     * @return array<int, array<string, mixed>>
     */
    private function fakeRecentRuns(): array
    {
        $rows = [
            [814_502_113, 'green_wave', 'normal', 'camera', 24.1, 48.6, 70.2, null],
            [199_034_771, 'green_wave', 'load_shedding', 'magnetometer', 70.8, 22.9, 25.6, 114.0],
            [402_118_965, 'adaptive', 'normal', 'radar', 30.9, 45.1, 32.4, null],
            [671_255_308, 'adaptive', 'load_shedding', 'camera', 88.1, 19.2, 5.9, 141.3],
            [530_887_142, 'adaptive', 'load_shedding', 'inductive_loop', 82.4, 20.6, 7.8, 121.6],
            [118_640_927, 'fixed', 'normal', null, 43.2, 37.8, 17.6, null],
            [905_773_456, 'fixed', 'load_shedding', null, 79.6, 21.1, 6.8, 98.2],
            [287_449_610, 'green_wave', 'normal', 'inductive_loop', 25.4, 47.2, 66.9, null],
        ];

        return array_map(fn (array $row, int $i) => [
            'id' => 1_284 - $i,
            'seed' => $row[0],
            'controller_mode' => $row[1],
            'power_state' => $row[2],
            'sensor_mode' => $row[3],
            'corridor_config' => 'hatfield-pretorius-francisbaard',
            'avg_wait_time' => $row[4],
            'throughput_per_min' => $row[5],
            'pct_cleared_without_stop' => $row[6],
            'time_to_recovery_seconds' => $row[7],
        ], $rows, array_keys($rows));
    }
}
