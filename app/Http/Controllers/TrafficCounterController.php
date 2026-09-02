<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreTrafficCountRequest;
use App\Jobs\ProcessTrafficCount;
use App\Models\TrafficCount;
use App\Support\CorridorRepository;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Storage;
use Illuminate\View\View;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * Third tab (Traffic Counter spec) - upload real traffic video, detect/count
 * vehicles via a queued job that shells out to Python/YOLOv8, and produce
 * flow statistics that validate (and optionally calibrate, see §10-11) the
 * simulator's synthetic sinusoidal demand.
 *
 * Unlike /api/simulation-runs and /api/recovery-ticks (no-auth, CSRF-exempt,
 * driven by a headless CLI with no browser session), every route here stays
 * inside the normal `auth` + CSRF group - it's driven by a logged-in user's
 * browser session (spec §2).
 */
class TrafficCounterController extends Controller
{
    public function __construct(private readonly CorridorRepository $corridors) {}

    public function index(): View
    {
        $corridors = $this->corridors->index();
        $counts = TrafficCount::query()->latest()->limit(20)->get();

        return view('traffic-counter', [
            'corridors' => $corridors,
            'defaultCorridorId' => $corridors[0]['id'] ?? null,
            'recentCounts' => $counts,
        ]);
    }

    public function store(StoreTrafficCountRequest $request): JsonResponse
    {
        $video = $request->file('video');
        $path = $video->store('traffic-counts', 'local');

        $count = TrafficCount::query()->create([
            'corridor_config' => $request->validated('corridor_config'),
            'street' => $request->validated('street'),
            'label' => $request->validated('label') ?: ($video->getClientOriginalName().' · '.now()->toDateString()),
            'video_path' => $path,
            'line_coords_json' => json_decode((string) $request->validated('line_coords'), true),
            'status' => 'pending',
        ]);

        ProcessTrafficCount::dispatch($count->id, (bool) $request->boolean('save_annotated_video'));

        return response()->json(['id' => $count->id], 201);
    }

    public function status(TrafficCount $trafficCount): JsonResponse
    {
        return response()->json([
            'id' => $trafficCount->id,
            'status' => $trafficCount->status,
            'error_message' => $trafficCount->error_message,
        ]);
    }

    /**
     * Finished stats + bucket series, for the results panel (spec §9). Only
     * meaningful once status = done; the front end doesn't call this until
     * polling status() confirms that.
     */
    public function data(TrafficCount $trafficCount): JsonResponse
    {
        return response()->json([
            'count' => [
                'id' => $trafficCount->id,
                'label' => $trafficCount->label,
                'corridor_config' => $trafficCount->corridor_config,
                'street' => $trafficCount->street,
                'status' => $trafficCount->status,
                'observation_duration_seconds' => $trafficCount->observation_duration_seconds,
                'frames_processed' => $trafficCount->frames_processed,
                'vehicles_detected' => $trafficCount->vehicles_detected,
                'total_vehicles' => $trafficCount->total_vehicles,
                'cars_count' => $trafficCount->cars_count,
                'trucks_count' => $trafficCount->trucks_count,
                'unclassified_count' => $trafficCount->unclassified_count,
                'mean_flow' => $trafficCount->mean_flow,
                'min_flow' => $trafficCount->min_flow,
                'max_flow' => $trafficCount->max_flow,
                'std_dev' => $trafficCount->std_dev,
                'peak_5min_flow' => $trafficCount->peak_5min_flow,
                'fitted_mid' => $trafficCount->fitted_mid,
                'fitted_amplitude' => $trafficCount->fitted_amplitude,
                'fitted_r_squared' => $trafficCount->fitted_r_squared,
                'assumed_period_seconds' => $trafficCount->assumed_period_seconds,
                'has_annotated_video' => $trafficCount->annotated_video_path !== null,
            ],
            'buckets' => $trafficCount->buckets()->orderBy('bucket_start_seconds')->get(
                ['bucket_start_seconds', 'vehicles_per_min', 'cars', 'trucks']
            ),
        ]);
    }

    /**
     * Serves the annotated QA video (spec §8) through an authenticated route,
     * never a public storage path - the raw upload never gets its own route
     * at all, it's deleted once processing is confirmed correct (spec §14).
     *
     * `BinaryFileResponse` (not `Storage::response()`'s plain `StreamedResponse`,
     * which just `fpassthru()`s the whole file with no `Range` support) - the
     * player's scrub bar needs the browser to be able to request an arbitrary
     * byte range and get a 206 back, or it can only play sequentially from the
     * start. Laravel's router calls `prepare($request)` on every response,
     * which is what makes `BinaryFileResponse` actually honour `Range` headers.
     */
    public function video(TrafficCount $trafficCount): BinaryFileResponse
    {
        abort_unless($trafficCount->annotated_video_path, Response::HTTP_NOT_FOUND);

        return response()->file(Storage::disk('local')->path($trafficCount->annotated_video_path));
    }
}
