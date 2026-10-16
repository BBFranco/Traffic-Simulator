<?php

namespace Tests\Feature;

use App\Enums\PowerState;
use App\Models\SimulationRunRecoveryTick;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class RecoveryTicksStoreTest extends TestCase
{
    use RefreshDatabase;

    private function curve(array $overrides = [], float $throughput = 150): array
    {
        return [
            'controller_mode' => 'fixed',
            'sensor_mode' => null,
            'corridor_config' => 'hatfield-realistic',
            'routing_mode' => 'random',
            'power_event_seconds' => 900,
            'power_outage_end_seconds' => 1800,
            'ticks' => collect([0, 9000, 18000, 27000])->map(fn (int $tick): array => [
                'tick' => $tick,
                'seconds' => $tick / 10,
                'throughput_per_min' => $throughput,
                'throughput_per_min_arterial' => 100,
                'throughput_per_min_side_street' => 50,
                'avg_wait_time' => 20,
                'avg_wait_time_arterial' => 15,
                'avg_wait_time_side_street' => 25,
            ])->all(),
            ...$overrides,
        ];
    }

    public function test_a_rolling_blackout_curve_does_not_replace_the_total_blackouts(): void
    {
        $this->postJson(route('recovery-ticks.store'), $this->curve(['power_state' => 'load_shedding']))->assertCreated();
        $this->postJson(route('recovery-ticks.store'), $this->curve([
            'power_state' => 'rolling_blackout',
            'power_outage_end_seconds' => 2700,
            'dark_windows' => [['zones' => [1, 3], 'fromS' => 900, 'toS' => 1800], ['zones' => [2], 'fromS' => 1800, 'toS' => 2700]],
        ], throughput: 120))->assertCreated();
        // A rerun of the total blackout replaces only its own curve.
        $this->postJson(route('recovery-ticks.store'), $this->curve(['power_state' => 'load_shedding'], throughput: 140))->assertCreated();

        $this->assertSame(4, SimulationRunRecoveryTick::query()->where('power_state', PowerState::LoadShedding)->count());
        $this->assertSame(4, SimulationRunRecoveryTick::query()->where('power_state', PowerState::RollingBlackout)->count());

        $timeline = $this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->json('recoveryTimeline');

        $this->assertSame('load_shedding', $timeline['powerState']);
        $this->assertEquals(140, $timeline['series']['fixed|']['throughput_per_min'][0]);
        $this->assertEquals([['zones' => null, 'fromS' => 900, 'toS' => 1800]], $timeline['darkWindows']);

        $rolling = $timeline['byPowerState']['rolling_blackout'];
        $this->assertEquals(120, $rolling['series']['fixed|']['throughput_per_min'][0]);
        $this->assertEquals(2700, $rolling['sheddingEnd']);
        $this->assertEquals([2], $rolling['darkWindows'][1]['zones']);
    }

    public function test_a_curve_without_a_power_state_is_a_total_blackout(): void
    {
        $this->postJson(route('recovery-ticks.store'), $this->curve())->assertCreated();

        $this->assertSame(PowerState::LoadShedding, SimulationRunRecoveryTick::query()->first()->power_state);
    }

    public function test_a_normal_power_curve_is_rejected(): void
    {
        $this->postJson(route('recovery-ticks.store'), $this->curve(['power_state' => 'normal']))
            ->assertUnprocessable()
            ->assertJsonValidationErrors('power_state');
    }
}
