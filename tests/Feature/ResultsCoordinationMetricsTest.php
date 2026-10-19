<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class ResultsCoordinationMetricsTest extends TestCase
{
    use RefreshDatabase;

    private function storeRun(string $batchId, int $seed, float $marriedShare, int $messages): void
    {
        $this->postJson(route('simulation-runs.store'), ['runs' => [[
            'batch_id' => $batchId,
            'seed' => $seed,
            'controller_mode' => 'coordinated_adaptive',
            'sensor_mode' => 'camera',
            'power_state' => 'normal',
            'corridor_config' => 'hatfield-realistic',
            'avg_wait_time' => 19,
            'avg_wait_time_arterial' => 14,
            'avg_wait_time_side_street' => 12,
            'throughput_per_min' => 170,
            'throughput_per_min_arterial' => 150,
            'throughput_per_min_side_street' => 100,
            'pct_cleared_without_stop' => 8,
            'pct_cleared_without_stop_arterial' => 24,
            'pct_cleared_without_stop_side_street' => 25,
            // 36000 ticks x 0.1 s = one measured hour.
            'raw_config_json' => ['durationTicks' => 36000, 'dt' => 0.1],
            'coordination_stats' => [
                'marriedShare' => $marriedShare,
                'nodes' => [
                    'pt_grosvenor' => ['routeId' => 'pretorius', 'marriedShare' => $marriedShare],
                    'stanza_hilda' => ['routeId' => 'stanza', 'marriedShare' => 0],
                ],
                'routes' => [
                    'pretorius' => ['meanCycleS' => 60, 'retunes' => 20],
                    'stanza' => ['meanCycleS' => 40, 'retunes' => 10],
                ],
                'recoveryHolds' => 0,
                'platoon' => ['messages' => $messages, 'holds' => 5, 'holdS' => 12.5],
                'greenEnds' => ['yield' => 30, 'gapOut' => 10],
            ],
        ]]])->assertCreated();
    }

    public function test_coordination_metrics_summarise_the_runs_coordination_stats(): void
    {
        $batchId = (string) Str::uuid();
        $this->storeRun($batchId, 1, 0.5, 1000);
        $this->storeRun($batchId, 2, 0.7, 3000);

        $metrics = $this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->json('coordinationMetrics');

        $condition = $metrics['conditions'][0];
        $this->assertSame(2, $condition['runs']);
        $this->assertEquals(60.0, $condition['married_pct']);
        // Only the route with a married junction counts towards the cycle.
        $this->assertEquals(60.0, $condition['mean_cycle_s']);
        $this->assertEquals(30.0, $condition['retunes_per_hour']);
        $this->assertEquals(2000.0, $condition['messages_per_hour']);
        $this->assertEquals(75.0, $condition['green_ends_pct']['yield']);

        $this->assertSame('pt_grosvenor', $metrics['junctions'][0]['node_id']);
        $this->assertEquals(60.0, $metrics['junctions'][0]['married_pct']);
        $this->assertEquals(0.0, $metrics['junctions'][1]['married_pct']);
    }
}
