<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class ResultsRoadWaitsTest extends TestCase
{
    use RefreshDatabase;

    private function storeRun(string $batchId, int $seed, string $mode, float $wait, float $roadWait, string $power = 'normal', ?float $married = null): void
    {
        $this->postJson(route('simulation-runs.store'), ['runs' => [[
            'batch_id' => $batchId,
            'seed' => $seed,
            'controller_mode' => $mode,
            'sensor_mode' => $mode === 'fixed' ? null : 'camera',
            'power_state' => $power,
            'corridor_config' => 'hatfield-realistic',
            'avg_wait_time' => $wait,
            'avg_wait_time_arterial' => $wait,
            'avg_wait_time_side_street' => $wait,
            'throughput_per_min' => 170,
            'throughput_per_min_arterial' => 150,
            'throughput_per_min_side_street' => 100,
            'pct_cleared_without_stop' => 8,
            'pct_cleared_without_stop_arterial' => 24,
            'pct_cleared_without_stop_side_street' => 25,
            'raw_config_json' => ['durationTicks' => 36000, 'dt' => 0.1],
            'road_waits' => ['jan_shoba' => ['name' => 'Jan Shoba', 'scope' => 'arterial', 'vehicles' => 100, 'meanWait' => $roadWait, 'maxWait' => 90]],
            ...($married === null ? [] : ['coordination_stats' => [
                'marriedShare' => $married,
                'nodes' => ['pt_grosvenor' => ['routeId' => 'pretorius', 'marriedShare' => $married]],
                'routes' => ['pretorius' => ['meanCycleS' => 60, 'retunes' => 1]],
                ...($power === 'rolling_blackout' ? [
                    'byStage' => ['pre' => ['marriedShare' => 0.8, 'routeCycleS' => 70.9], 'stage1' => ['marriedShare' => 0.2, 'routeCycleS' => 64], 'stage2' => ['marriedShare' => 0.3, 'routeCycleS' => 66], 'post' => ['marriedShare' => 0.7, 'routeCycleS' => 71.1]],
                    'restores' => [['atS' => 1800, 'stage' => 'stage2', 'holdS' => 20], ['atS' => 2700, 'stage' => 'post', 'holdS' => 30]],
                ] : []),
            ]]),
        ]]])->assertCreated();
    }

    public function test_road_waits_and_coordinated_vs_adaptive_are_paired_on_the_same_seeds(): void
    {
        $batchId = (string) Str::uuid();
        foreach ([1, 2, 3, 4] as $seed) {
            $this->storeRun($batchId, $seed, 'fixed', 40, 30 + $seed);
            $this->storeRun($batchId, $seed, 'adaptive', 30, 20 + $seed);
            $this->storeRun($batchId, $seed, 'coordinated_adaptive', 24, 10 + $seed, married: 0.5);
        }

        $payload = $this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->json();

        $road = collect($payload['roadWaits'])->firstWhere('road_id', 'jan_shoba');
        $this->assertSame('Jan Shoba', $road['name']);
        $this->assertEquals(32.5, $road['fixed']);
        $this->assertEquals(12.5, $road['coordinated_adaptive']);
        // Per seed 10+s against 30+s: a constant gap, so a negative delta with no spread.
        $this->assertLessThan(0, $road['coordinated_vs_fixed']['delta']);
        $this->assertEquals(0.0, $road['coordinated_vs_fixed']['ci95']);
        $this->assertEquals(-44.4, $road['coordinated_vs_adaptive']['delta']);

        $versus = $payload['coordinationMetrics']['versus_adaptive']['camera|normal'];
        $this->assertEquals(-20.0, $versus['avg_wait_time']['delta']);
        $this->assertSame(4, $versus['avg_wait_time']['pairs']);
        $this->assertArrayHasKey('average|normal', $payload['coordinationMetrics']['versus_adaptive']);
    }

    public function test_per_junction_married_share_is_reported_for_every_power_state(): void
    {
        $batchId = (string) Str::uuid();
        $this->storeRun($batchId, 1, 'coordinated_adaptive', 24, 10, married: 0.6);
        $this->storeRun($batchId, 2, 'coordinated_adaptive', 24, 10, power: 'load_shedding', married: 0.5);
        $this->storeRun($batchId, 3, 'coordinated_adaptive', 24, 10, power: 'rolling_blackout', married: 0.4);

        $junction = $this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->json('coordinationMetrics.junctions.0');

        $this->assertEquals(60.0, $junction['married_pct']);
        $this->assertEquals(50.0, $junction['married_pct_load_shedding']);
        $this->assertEquals(['normal' => 60.0, 'load_shedding' => 50.0, 'rolling_blackout' => 40.0], $junction['married_pct_by_power']);
    }

    public function test_a_rolling_blackout_reports_jan_shobas_married_share_by_stage_and_its_resync_holds_per_restore(): void
    {
        $batchId = (string) Str::uuid();
        $this->storeRun($batchId, 1, 'coordinated_adaptive', 24, 10, power: 'rolling_blackout', married: 0.4);

        $condition = collect($this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->json('coordinationMetrics.conditions'))
            ->firstWhere('power_state', 'rolling_blackout');

        $this->assertSame(['pre', 'stage1', 'stage2', 'post'], array_keys($condition['by_stage']));
        $this->assertEquals(20.0, $condition['by_stage']['stage1']['married_pct']);
        $this->assertEquals(70.9, $condition['by_stage']['pre']['route_cycle_s']);
        $this->assertSame(['stage2', 'post'], array_column($condition['restores'], 'stage'));
        $this->assertEquals(30.0, $condition['restores'][1]['hold_s']);
        $this->assertEquals(1.0, $condition['restores'][0]['per_run']);
    }

    public function test_road_waits_are_split_by_the_rolling_blackout_too(): void
    {
        $batchId = (string) Str::uuid();
        foreach ([1, 2, 3] as $seed) {
            $this->storeRun($batchId, $seed, 'fixed', 40, 30, 'rolling_blackout');
            $this->storeRun($batchId, $seed, 'adaptive', 30, 20 + $seed, 'rolling_blackout');
        }

        $road = collect($this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->json('roadWaits'))
            ->firstWhere('power_state', 'rolling_blackout');

        $this->assertSame('jan_shoba', $road['road_id']);
        $this->assertEquals(22.0, $road['adaptive']);
        $this->assertEquals(-26.7, $road['adaptive_vs_fixed']['delta']);
    }
}
