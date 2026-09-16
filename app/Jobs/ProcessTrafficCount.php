<?php

namespace App\Jobs;

use App\Models\TrafficCount;
use App\Models\TrafficCountBucket;
use App\Support\CorridorRepository;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use RuntimeException;
use Throwable;

/**
 * Runs the Python/YOLOv8 detection+counting+fit pipeline for one uploaded
 * video (Traffic Counter spec §5-6). Video processing takes real time
 * (minutes), so this is queued rather than synchronous - requires a queue
 * worker running (`php artisan queue:work`; QUEUE_CONNECTION is already
 * `database` in this app's .env, no further config needed).
 *
 * This is the first use of Laravel's Process facade in this codebase - every
 * other data-writing path here is a plain JS `fetch()` from the browser or a
 * headless Node CLI, since the simulation itself deliberately never runs in
 * PHP (see SimulatorController's docblock). Video detection is the one piece
 * of this app that has to run server-side.
 */
class ProcessTrafficCount implements ShouldQueue
{
    use Queueable;

    /** Real-world video processing, not a quick request - give it room. */
    public int $timeout = 3600;

    public function __construct(
        private readonly int $trafficCountId,
        private readonly bool $saveAnnotatedVideo,
    ) {}

    public function handle(CorridorRepository $corridors): void
    {
        $count = TrafficCount::query()->findOrFail($this->trafficCountId);
        $count->update(['status' => 'processing', 'error_message' => null]);

        try {
            [$lanes, $periodSeconds] = $this->laneCountAndPeriod($corridors, $count);

            $videoPath = Storage::disk('local')->path($count->video_path);
            $annotatedRelativePath = $this->saveAnnotatedVideo
                ? 'traffic-counts/'.$count->id.'/annotated.mp4'
                : null;
            $annotatedAbsolutePath = $annotatedRelativePath
                ? Storage::disk('local')->path($annotatedRelativePath)
                : null;
            if ($annotatedAbsolutePath) {
                Storage::disk('local')->makeDirectory('traffic-counts/'.$count->id);
            }

            $result = $this->runPython($videoPath, $count, $lanes, $periodSeconds, $annotatedAbsolutePath);

            $count->update([
                'observation_duration_seconds' => $result['observation_duration_seconds'],
                'frames_processed' => $result['frames_processed'],
                'vehicles_detected' => $result['vehicles_detected'],
                'total_vehicles' => $result['total_vehicles'],
                'cars_count' => $result['cars_count'],
                'trucks_count' => $result['trucks_count'],
                'unclassified_count' => $result['unclassified_count'],
                'mean_flow' => $result['mean_flow'],
                'min_flow' => $result['min_flow'],
                'max_flow' => $result['max_flow'],
                'std_dev' => $result['std_dev'],
                'peak_5min_flow' => $result['peak_5min_flow'],
                'fitted_mid' => $result['fitted_mid'],
                'fitted_amplitude' => $result['fitted_amplitude'],
                'fitted_r_squared' => $result['fitted_r_squared'],
                'assumed_period_seconds' => $periodSeconds,
                'annotated_video_path' => $annotatedRelativePath,
                'status' => 'done',
            ]);

            $buckets = collect($result['buckets'])->map(fn (array $bucket) => [
                'traffic_count_id' => $count->id,
                'bucket_start_seconds' => $bucket['bucket_start_seconds'],
                'vehicles_per_min' => $bucket['vehicles_per_min'],
                'cars' => $bucket['cars'],
                'trucks' => $bucket['trucks'],
                'created_at' => now(),
            ]);
            if ($buckets->isNotEmpty()) {
                TrafficCountBucket::query()->insert($buckets->all());
            }

            // Raw video + annotated QA video are deleted once processing is confirmed
            // correct (spec §14) - a deliberate human-review step, not automatic here.
        } catch (Throwable $e) {
            Log::error('ProcessTrafficCount failed', ['traffic_count_id' => $count->id, 'error' => $e->getMessage()]);
            // The full message is always in the log above; what's stored here just needs to
            // be enough for the UI to show a useful reason, not a full traceback.
            $count->update(['status' => 'failed', 'error_message' => Str::limit($e->getMessage(), 2000)]);
        }
    }

    /**
     * @return array{0: int, 1: int} [lanes, fluctuationPeriodS] for the count's street,
     *                               read from the corridor config it was recorded against (spec §6's per-lane
     *                               conversion + fixed period input).
     */
    private function laneCountAndPeriod(CorridorRepository $corridors, TrafficCount $count): array
    {
        $config = $corridors->find($count->corridor_config);
        if (! $config) {
            throw new RuntimeException("Corridor config not found: {$count->corridor_config}");
        }

        foreach ([...($config['arterials'] ?? []), ...($config['connectors'] ?? [])] as $street) {
            if (($street['id'] ?? null) === $count->street || ($street['name'] ?? null) === $count->street) {
                return [(int) $street['lanes'], (int) ($street['demand']['fluctuationPeriodS'] ?? 300)];
            }
        }

        throw new RuntimeException("Street not found in corridor config: {$count->street}");
    }

    /**
     * @return array{
     *     observation_duration_seconds: int, frames_processed: int, vehicles_detected: int,
     *     total_vehicles: int, cars_count: int, trucks_count: int, unclassified_count: int,
     *     mean_flow: float, min_flow: float, max_flow: float, std_dev: float, peak_5min_flow: float,
     *     fitted_mid: float, fitted_amplitude: float, fitted_r_squared: float,
     *     buckets: array<int, array{bucket_start_seconds: int, vehicles_per_min: float, cars: int, trucks: int}>
     * }
     */
    private function runPython(string $videoPath, TrafficCount $count, int $lanes, int $periodSeconds, ?string $annotatedPath): array
    {
        $script = base_path('scripts/traffic_counter/count_vehicles.py');

        $args = [
            env('PYTHON_BIN', 'python'),
            $script,
            '--video', $videoPath,
            '--line-coords', json_encode($count->line_coords_json),
            '--lanes', (string) $lanes,
            '--period-seconds', (string) $periodSeconds,
            '--bucket-seconds', '300',
        ];
        if ($annotatedPath) {
            $args[] = '--annotated-output';
            $args[] = $annotatedPath;
        }

        $result = Process::timeout($this->timeout)->run($args);

        if (! $result->successful()) {
            throw new RuntimeException("count_vehicles.py failed: {$result->errorOutput()}");
        }

        // count_vehicles.py's own contract is "stdout is exactly one JSON line, nothing
        // else" (redirects everything incidental to stderr internally) - but a dependency
        // upgrade could still slip a stray print past that, so this parses only the last
        // non-empty line rather than trusting the whole captured stream is clean JSON.
        $lines = array_filter(explode("\n", trim($result->output())), fn ($line) => trim($line) !== '');
        $lastLine = end($lines) ?: '';

        $decoded = json_decode($lastLine, true);
        if (! is_array($decoded)) {
            throw new RuntimeException('count_vehicles.py did not return valid JSON on its last stdout line: '.Str::limit($result->output(), 2000));
        }

        return $decoded;
    }
}
