<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class ResultsConditionCiTest extends TestCase
{
    use RefreshDatabase;

    private function storeRun(string $batchId, int $seed, string $sensor, float $wait): void
    {
        $this->postJson(route('simulation-runs.store'), ['runs' => [[
            'batch_id' => $batchId,
            'seed' => $seed,
            'controller_mode' => 'adaptive',
            'sensor_mode' => $sensor,
            'power_state' => 'normal',
            'corridor_config' => 'hatfield-realistic',
            'avg_wait_time' => $wait,
            'avg_wait_time_arterial' => $wait,
            'avg_wait_time_side_street' => $wait,
            'throughput_per_min' => 170,
            'throughput_per_min_arterial' => 150,
            'throughput_per_min_side_street' => 100,
            'pct_cleared_without_stop' => 8,
            'pct_cleared_without_stop_arterial' => 19,
            'pct_cleared_without_stop_side_street' => 25,
            'raw_config_json' => ['warmupTicks' => 36000],
        ]]])->assertCreated();
    }

    public function test_the_sensor_average_ci_is_on_per_seed_means_not_pooled_runs(): void
    {
        $batchId = (string) Str::uuid();
        // Sensors differ by a constant 10 s, seeds by 0 s: the per-seed means are identical, so no spread.
        foreach ([20270101, 20270102, 20270103] as $seed) {
            $this->storeRun($batchId, $seed, 'camera', 20);
            $this->storeRun($batchId, $seed, 'radar', 30);
        }

        $aggregates = $this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->json('aggregates');

        $adaptive = collect($aggregates)->firstWhere('controller_mode', 'adaptive');
        $this->assertSame(6, $adaptive['runs']);
        $this->assertEquals(25.0, $adaptive['avg_wait_time']);
        $this->assertEquals(0.0, $adaptive['avg_wait_time_ci95']);
    }
}
