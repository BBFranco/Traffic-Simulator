<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class LatestBatchProgressTest extends TestCase
{
    use RefreshDatabase;

    /** @return array<string, mixed> */
    private function runPayload(string $batchId, int $seed, array $overrides = []): array
    {
        return [
            'batch_id' => $batchId,
            'batch_started_at' => '2026-10-16T08:23:30Z',
            'warmup_ticks' => 31800,
            'warmup_stationary' => true,
            'seed' => $seed,
            'controller_mode' => 'fixed',
            'sensor_mode' => null,
            'routing_mode' => 'destination',
            'power_state' => 'normal',
            'corridor_config' => 'hatfield-realistic',
            'avg_wait_time' => 20,
            'avg_wait_time_arterial' => 18,
            'avg_wait_time_side_street' => 25,
            'throughput_per_min' => 300,
            'throughput_per_min_arterial' => 200,
            'throughput_per_min_side_street' => 100,
            'pct_cleared_without_stop' => 30,
            'pct_cleared_without_stop_arterial' => 35,
            'pct_cleared_without_stop_side_street' => 20,
            'raw_config_json' => ['warmupTicks' => 31800, 'build' => ['commit' => 'abc1234', 'sim' => 'f00d'], 'demandOverrides' => ['stanza' => ['min' => 4, 'max' => 8, 'saturationFlowPerLanePerHour' => 1250]]],
            ...$overrides,
        ];
    }

    public function test_it_lists_the_latest_main_batch_runs_and_settings(): void
    {
        $older = (string) Str::uuid();
        $latest = (string) Str::uuid();
        $this->postJson(route('simulation-runs.store'), ['runs' => [$this->runPayload($older, 1)]])->assertCreated();
        $this->postJson(route('simulation-runs.store'), ['runs' => [
            $this->runPayload($latest, 20260101),
            $this->runPayload($latest, 20260102, ['power_state' => 'load_shedding']),
        ]])->assertCreated();
        // A sensitivity batch never becomes the one to resume.
        $this->postJson(route('simulation-runs.store'), ['runs' => [$this->runPayload((string) Str::uuid(), 5, ['batch_kind' => 'sensitivity'])]])->assertCreated();

        $this->actingAs(User::factory()->create())
            ->getJson(route('results.latest-batch-progress'))
            ->assertOk()
            ->assertJsonPath('batchId', $latest)
            ->assertJsonPath('routingMode', 'destination')
            ->assertJsonPath('warmup.warmupTicks', 31800)
            ->assertJsonPath('build.sim', 'f00d')
            ->assertJsonPath('demandOverrides.stanza.max', 8)
            ->assertJsonCount(2, 'runs')
            ->assertJsonFragment(['seed' => 20260102, 'controllerMode' => 'fixed', 'sensorMode' => null, 'powerState' => 'load_shedding']);
    }

    public function test_it_is_null_without_any_batch(): void
    {
        $this->actingAs(User::factory()->create())
            ->getJson(route('results.latest-batch-progress'))
            ->assertOk()
            ->assertExactJson([]);
    }
}
