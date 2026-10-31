<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class ResultsAdaptiveMaxSensitivityTest extends TestCase
{
    use RefreshDatabase;

    /** @return array<string, mixed> */
    private function runPayload(string $batchId, int $seed, array $overrides = [], ?string $tag = null, array $wait = [10, 20], array $zone2 = [100]): array
    {
        return [
            'batch_id' => $batchId,
            'batch_started_at' => '2026-10-30T08:00:00Z',
            'warmup_ticks' => 31800,
            'seed' => $seed,
            'controller_mode' => 'adaptive',
            'sensor_mode' => 'inductive_loop',
            'routing_mode' => 'destination',
            'power_state' => 'rolling_blackout',
            'corridor_config' => 'hatfield-realistic',
            'batch_kind' => $tag ? 'sensitivity' : 'main',
            'avg_wait_time' => 20,
            'avg_wait_time_arterial' => 18,
            'avg_wait_time_side_street' => 25,
            'throughput_per_min' => 300,
            'throughput_per_min_arterial' => 200,
            'throughput_per_min_side_street' => 100,
            'pct_cleared_without_stop' => 30,
            'pct_cleared_without_stop_arterial' => 35,
            'pct_cleared_without_stop_side_street' => 20,
            'diagnostics' => [
                'waitSeries' => ['binS' => 60, 'total' => $wait],
                'zoneFlow' => ['binS' => 300, 'standing' => ['1' => [5], '2' => $zone2]],
            ],
            'raw_config_json' => ['warmupTicks' => 31800, ...($tag ? ['tag' => $tag] : [])],
            ...$overrides,
        ];
    }

    private function store(array $runs): void
    {
        $this->postJson(route('simulation-runs.store'), ['runs' => $runs])->assertCreated();
    }

    private function getFeed(): TestResponse
    {
        return $this->actingAs(User::factory()->create())
            ->getJson(route('results.adaptive-max-sensitivity', ['routing' => 'destination']));
    }

    public function test_it_averages_each_arm_over_its_seeds(): void
    {
        $main = (string) Str::uuid();
        $default = (string) Str::uuid();
        $sartsm = (string) Str::uuid();
        $this->store([
            $this->runPayload($main, 1, ['controller_mode' => 'fixed', 'sensor_mode' => null], null, [30, 40], [200]),
            $this->runPayload($main, 2, ['controller_mode' => 'fixed', 'sensor_mode' => null], null, [50, null], [300]),
            // Main-batch adaptive and normal-power runs never reach the figure.
            $this->runPayload($main, 1, [], null, [999], [999]),
            $this->runPayload($main, 3, ['controller_mode' => 'fixed', 'sensor_mode' => null, 'power_state' => 'normal'], null, [999], [999]),
        ]);
        $this->store([
            $this->runPayload($default, 1, [], 'adaptive-max-45', [10, 20], [400]),
            $this->runPayload($default, 2, [], 'adaptive-max-45', [20, 40, 60], [500]),
            $this->runPayload($default, 3, ['sensor_mode' => 'radar'], 'adaptive-max-45', [999], [999]),
        ]);
        $this->store([$this->runPayload($sartsm, 1, [], 'adaptive-max-sartsm', [5, 6], [250])]);

        $this->getFeed()
            ->assertOk()
            ->assertJsonPath('batchIds.default', $default)
            ->assertJsonPath('batchIds.sartsm', $sartsm)
            ->assertJsonPath('arms.fixed.n', 2)
            ->assertJsonPath('arms.fixed.wait', [40, 40])
            ->assertJsonPath('arms.fixed.zone2Standing', [250])
            ->assertJsonPath('arms.default.n', 2)
            ->assertJsonPath('arms.default.waitBinS', 60)
            ->assertJsonPath('arms.default.wait', [15, 30, 60])
            ->assertJsonPath('arms.default.standingBinS', 300)
            ->assertJsonPath('arms.default.zone2Standing', [450])
            ->assertJsonPath('arms.sartsm.wait', [5, 6]);
    }

    public function test_it_is_null_until_both_arms_have_run(): void
    {
        $this->store([$this->runPayload((string) Str::uuid(), 1, ['controller_mode' => 'fixed', 'sensor_mode' => null])]);
        $this->store([$this->runPayload((string) Str::uuid(), 1, [], 'adaptive-max-sartsm')]);

        $this->getFeed()->assertOk()->assertExactJson([]);
    }

    public function test_the_sensitivity_batches_never_become_the_main_batch(): void
    {
        $main = (string) Str::uuid();
        $this->store([$this->runPayload($main, 1, ['controller_mode' => 'fixed', 'sensor_mode' => null])]);
        $this->store([$this->runPayload((string) Str::uuid(), 1, [], 'adaptive-max-45')]);
        $this->store([$this->runPayload((string) Str::uuid(), 1, [], 'adaptive-max-sartsm')]);

        $this->actingAs(User::factory()->create())
            ->getJson(route('results.appendix-runs', ['routing' => 'destination']))
            ->assertOk()
            ->assertJsonCount(1)
            ->assertJsonPath('0.controller_mode', 'fixed');
    }
}
