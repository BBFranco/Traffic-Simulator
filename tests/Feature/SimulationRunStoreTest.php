<?php

namespace Tests\Feature;

use App\Models\SimulationRun;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class SimulationRunStoreTest extends TestCase
{
    use RefreshDatabase;

    /** @return array<string, mixed> */
    private function runPayload(array $overrides = []): array
    {
        return [
            'batch_id' => (string) Str::uuid(),
            'seed' => 1,
            'controller_mode' => 'fixed',
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
            'raw_config_json' => ['warmupTicks' => 0],
            ...$overrides,
        ];
    }

    public function test_a_destination_run_stores_its_routing_metrics(): void
    {
        $stats = ['trips' => 9743, 'pulledOffByBlock' => ['GRO-3' => 120], 'drivewayFallbacks' => ['sameBlock' => 4, 'nextBlock' => 2, 'exit' => 1]];

        $this->postJson(route('simulation-runs.store'), ['runs' => [$this->runPayload([
            'routing_mode' => 'destination',
            'trips' => 9743,
            'mean_trip_time' => 208.6,
            'mean_trip_delay' => 61.2,
            'pulled_off' => 4426,
            'missed_turns' => 857,
            'missed_driveways' => 124,
            'diversion_pct' => 2.6,
            'routing_stats' => $stats,
        ])]])->assertCreated();

        $run = SimulationRun::query()->sole();
        $this->assertSame(4426, $run->pulled_off);
        $this->assertEqualsWithDelta(61.2, $run->mean_trip_delay, 1e-9);
        $this->assertSame($stats, $run->routing_stats);
    }

    public function test_a_random_run_leaves_the_routing_metrics_empty(): void
    {
        $this->postJson(route('simulation-runs.store'), ['runs' => [$this->runPayload(['trips' => null, 'routing_stats' => null])]])->assertCreated();

        $run = SimulationRun::query()->sole();
        $this->assertNull($run->trips);
        $this->assertNull($run->routing_stats);
    }

    public function test_results_shows_the_trip_table_for_a_destination_batch_only(): void
    {
        $this->postJson(route('simulation-runs.store'), ['runs' => [$this->runPayload([
            'routing_mode' => 'destination',
            'trips' => 100,
            'mean_trip_time' => 208.6,
            'mean_trip_delay' => 61.2,
            'pulled_off' => 40,
            'missed_turns' => 9,
            'missed_driveways' => 2,
            'diversion_pct' => 2.6,
        ])]])->assertCreated();

        $user = User::factory()->create();
        $this->actingAs($user)->get('/results?routing=destination')
            ->assertOk()
            ->assertSee('Destination routing - trips')
            ->assertSee('61.2');
        $this->actingAs($user)->get('/results')
            ->assertOk()
            ->assertDontSee('Destination routing - trips');
    }

    public function test_a_run_stores_its_diagnostics_and_names_the_drifting_controller(): void
    {
        $drifting = [['controllerMode' => 'green_wave', 'scopes' => ['total' => 63, 'sideStreet' => 82]]];

        $this->postJson(route('simulation-runs.store'), ['runs' => [$this->runPayload([
            'warmup_stationary' => false,
            'warmup_drifting' => $drifting,
            'diagnostics' => ['arrivalsLost' => 12, 'roundaboutOverruns' => 0],
        ])]])->assertCreated();

        $run = SimulationRun::query()->sole();
        $this->assertSame($drifting, $run->warmup_drifting);
        $this->assertSame(12, $run->diagnostics['arrivalsLost']);

        $this->actingAs(User::factory()->create())->get('/results')
            ->assertOk()
            ->assertSee('Green wave (total +63%, side streets +82%)');
    }

    public function test_the_replay_picker_offers_the_latest_batch_of_the_requested_routing_mode(): void
    {
        $random = $this->runPayload(['routing_mode' => 'random']);
        $destination = $this->runPayload(['routing_mode' => 'destination', 'seed' => 7]);
        $this->postJson(route('simulation-runs.store'), ['runs' => [$random]])->assertCreated();
        $this->postJson(route('simulation-runs.store'), ['runs' => [$destination]])->assertCreated();

        $user = User::factory()->create();
        $this->actingAs($user)->getJson(route('simulator.sample-runs', ['corridor' => 'hatfield-realistic', 'routing' => 'destination']))
            ->assertOk()
            ->assertJsonCount(1, 'runs')
            ->assertJsonPath('runs.0.routing_mode', 'destination')
            ->assertJsonPath('runs.0.seed', 7);
        $this->actingAs($user)->getJson(route('simulator.sample-runs', ['corridor' => 'hatfield-realistic']))
            ->assertOk()
            ->assertJsonPath('runs.0.routing_mode', 'random');
    }
}
