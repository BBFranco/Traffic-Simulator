<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class ResultsLockupBannerTest extends TestCase
{
    use RefreshDatabase;

    private function storeRun(string $batchId, int $seed, ?array $lockup): void
    {
        $this->postJson(route('simulation-runs.store'), ['runs' => [[
            'batch_id' => $batchId,
            'seed' => $seed,
            'controller_mode' => 'adaptive',
            'sensor_mode' => 'camera',
            'power_state' => 'load_shedding',
            'corridor_config' => 'hatfield-realistic',
            'avg_wait_time' => 45,
            'avg_wait_time_arterial' => 40,
            'avg_wait_time_side_street' => 20,
            'throughput_per_min' => 140,
            'throughput_per_min_arterial' => 120,
            'throughput_per_min_side_street' => 90,
            'pct_cleared_without_stop' => 5,
            'pct_cleared_without_stop_arterial' => 10,
            'pct_cleared_without_stop_side_street' => 20,
            'raw_config_json' => ['warmupTicks' => 36000],
            'diagnostics' => ['arrivalsLost' => 155, 'roundaboutOverruns' => 0, 'lockup' => $lockup],
        ]]])->assertCreated();
    }

    public function test_a_locked_run_is_named_in_the_results_banner(): void
    {
        $batchId = (string) Str::uuid();
        $this->storeRun($batchId, 20270101, ['longestStillS' => 104, 'cycles' => 0, 'firstCycle' => null, 'isLockup' => false]);
        $this->storeRun($batchId, 20270104, [
            'longestStillS' => 3150,
            'longestStill' => ['carId' => 11286, 'nodeId' => 'south_hilda', 'place' => 'round south_hilda', 'atS' => 7200],
            'cycles' => 2,
            'firstCycle' => ['carIds' => [11286, 11504], 'nodeIds' => ['south_hilda'], 'places' => ['round south_hilda', 'round south_hilda'], 'heldS' => 60, 'atS' => 4112],
            'isLockup' => true,
        ]);

        $this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->assertJsonPath('lockupLabel', 'Adaptive (camera), load shedding, seed 20270104 at south_hilda');
    }

    public function test_a_batch_without_lockups_has_no_banner(): void
    {
        $this->storeRun((string) Str::uuid(), 20270101, ['longestStillS' => 104, 'cycles' => 0, 'firstCycle' => null, 'isLockup' => false]);

        $this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->assertJsonPath('lockupLabel', null)
            ->assertJsonPath('starvedLabel', null);
    }

    public function test_a_starved_approach_is_listed_but_not_a_lockup(): void
    {
        $starved = ['seconds' => 518, 'carId' => 11035, 'nodeId' => 'lynnwood_herold', 'place' => 'Herold Street, lane 0, 587 m', 'atS' => 4666];
        $this->storeRun((string) Str::uuid(), 20270129, ['longestStillS' => 518, 'locked' => null, 'starved' => $starved, 'cycles' => 0, 'firstCycle' => null, 'isLockup' => false]);

        $this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->assertJsonPath('lockupLabel', null)
            ->assertJsonPath('starvedLabel', 'Adaptive (camera), load shedding, seed 20270129 at lynnwood_herold (518 s)');
    }
}
