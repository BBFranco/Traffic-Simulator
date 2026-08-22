<?php

namespace App\Http\Controllers;

use App\Models\SimulationRun;
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
 * comes from the headless batch runner's own CSV output under `results/`,
 * not from the database - see csvRecoveryTimeline() below.
 */
class ResultsController extends Controller
{
    private const CONTROLLER_MODES = ['fixed', 'adaptive', 'green_wave'];

    private const POWER_STATES = ['normal', 'load_shedding'];

    /** Representative condition (mode -> results/ subfolder) the recovery line chart reads its CSV from. */
    private const RECOVERY_CONDITION_BY_MODE = [
        'fixed' => 'fixed_load_shedding',
        'adaptive' => 'adaptive_load_shedding_camera',
        'green_wave' => 'green_wave_load_shedding',
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
        $recentRuns = (clone $query)->latest('created_at')->limit(10)->get()
            ->map(fn (SimulationRun $run) => [
                'id' => $run->id,
                'seed' => $run->seed,
                'controller_mode' => $run->controller_mode,
                'power_state' => $run->power_state,
                'sensor_mode' => $run->sensor_mode,
                'corridor_config' => $run->corridor_config,
                'avg_wait_time' => $run->avg_wait_time,
                'throughput_per_min' => $run->throughput_per_min,
                'pct_cleared_without_stop' => $run->pct_cleared_without_stop,
                'time_to_recovery_seconds' => $run->time_to_recovery_seconds,
            ])->all();

        return [
            'aggregates' => $aggregates,
            'pairedComparisons' => $this->pairedComparisons($aggregates),
            'recoveryTimeline' => $this->csvRecoveryTimeline(),
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
        return $query
            ->selectRaw(
                'controller_mode, power_state, count(*) as runs, '.
                'avg(avg_wait_time) as avg_wait_time, '.
                'avg(throughput_per_min) as throughput_per_min, '.
                'avg(pct_cleared_without_stop) as pct_cleared_without_stop, '.
                'avg(time_to_recovery_seconds) as time_to_recovery_seconds'
            )
            ->groupBy('controller_mode', 'power_state')
            ->get()
            ->map(fn ($row) => [
                'controller_mode' => $row->controller_mode,
                'power_state' => $row->power_state,
                'runs' => (int) $row->runs,
                'avg_wait_time' => round((float) $row->avg_wait_time, 1),
                'throughput_per_min' => round((float) $row->throughput_per_min, 1),
                'pct_cleared_without_stop' => round((float) $row->pct_cleared_without_stop, 1),
                'time_to_recovery_seconds' => $row->time_to_recovery_seconds === null
                    ? null
                    : round((float) $row->time_to_recovery_seconds, 1),
            ])
            ->all();
    }

    /**
     * The dissertation's research question, answered directly: each ITS mode
     * against the fixed-time baseline, separately under normal power and
     * under load shedding.
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
                $baseline = $lookup['fixed|'.$power] ?? null;
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
     * Per-tick average wait, one representative run's CSV per controller mode
     * (the first seed found under that condition's results/ folder). Returns
     * null until the batch runner has actually produced that CSV - there is
     * no fallback to fake data here, an empty/missing chart is the honest
     * state before a run exists.
     *
     * @return array{seconds: array<int, float>, series: array<string, array<int, float>>, sheddingStart: ?float, sheddingEnd: ?float}|null
     */
    private function csvRecoveryTimeline(): ?array
    {
        $series = [];
        $seconds = null;
        $sheddingStartSeconds = null;

        foreach (self::RECOVERY_CONDITION_BY_MODE as $mode => $conditionKey) {
            $dir = base_path("results/{$conditionKey}");
            if (! is_dir($dir)) {
                continue;
            }

            $csvFiles = glob("{$dir}/*.csv") ?: [];
            if (! $csvFiles) {
                continue;
            }
            sort($csvFiles, SORT_NATURAL);
            $csvPath = $csvFiles[0];

            [$ticks, $avgWaitByTick] = $this->parseAvgWaitByTick($csvPath);
            if (! $ticks) {
                continue;
            }

            $dt = $this->dtFromSummary($csvPath) ?? 0.1;
            $secondsForThisRun = array_map(fn ($t) => round($t * $dt, 1), $ticks);
            $seconds ??= $secondsForThisRun;
            $series[$mode] = array_values($avgWaitByTick);

            if ($sheddingStartSeconds === null) {
                $powerEventTick = $this->powerEventTickFromSummary($csvPath);
                if ($powerEventTick !== null) {
                    $sheddingStartSeconds = round($powerEventTick * $dt, 1);
                }
            }
        }

        if (! $series || $seconds === null) {
            return null;
        }

        return [
            'seconds' => $seconds,
            'series' => $series,
            // No restoration event in this build's power model (a triggered
            // outage runs to the end of the batch run, see engine.js) - the
            // shaded band covers from the trigger to the end of the series.
            'sheddingStart' => $sheddingStartSeconds,
            'sheddingEnd' => $sheddingStartSeconds === null ? null : end($seconds),
        ];
    }

    /**
     * @return array{0: array<int, int>, 1: array<int, float>}
     */
    private function parseAvgWaitByTick(string $csvPath): array
    {
        $handle = fopen($csvPath, 'r');
        if ($handle === false) {
            return [[], []];
        }

        $header = fgetcsv($handle);
        $tickIndex = array_search('tick', $header, true);
        $waitIndex = array_search('avgWaitTime', $header, true);

        $sums = [];
        $counts = [];
        while (($row = fgetcsv($handle)) !== false) {
            if ($tickIndex === false || $waitIndex === false || ! isset($row[$tickIndex], $row[$waitIndex])) {
                continue;
            }
            $tick = (int) $row[$tickIndex];
            $sums[$tick] = ($sums[$tick] ?? 0.0) + (float) $row[$waitIndex];
            $counts[$tick] = ($counts[$tick] ?? 0) + 1;
        }
        fclose($handle);

        ksort($sums);
        $ticks = array_keys($sums);
        $avg = [];
        foreach ($ticks as $tick) {
            $avg[$tick] = round($sums[$tick] / $counts[$tick], 1);
        }

        return [$ticks, $avg];
    }

    private function summaryForCsv(string $csvPath): ?array
    {
        $jsonPath = preg_replace('/\.csv$/', '.json', $csvPath);
        if ($jsonPath === null || ! is_file($jsonPath)) {
            return null;
        }

        $decoded = json_decode((string) file_get_contents($jsonPath), true);

        return is_array($decoded) ? $decoded : null;
    }

    private function dtFromSummary(string $csvPath): ?float
    {
        return $this->summaryForCsv($csvPath)['rawConfig']['dt'] ?? null;
    }

    private function powerEventTickFromSummary(string $csvPath): ?int
    {
        return $this->summaryForCsv($csvPath)['rawConfig']['powerEvent'] ?? null;
    }
}
