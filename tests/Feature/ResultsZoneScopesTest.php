<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

class ResultsZoneScopesTest extends TestCase
{
    use RefreshDatabase;

    private function zone(float $wait, float $restoreSeconds, float $windowS): array
    {
        return [
            'avgWaitTime' => $wait,
            'medianWait' => $wait / 2,
            'p95Wait' => $wait * 3,
            'maxWait' => $wait * 10,
            'throughputPerMin' => 60,
            'clearedTotal' => 5400,
            'pctClearedWithoutStop' => 20,
            'segments' => [
                'pre' => ['avgWaitTime' => 20, 'throughputPerMin' => 62, 'clearedTotal' => 900],
                'during' => ['avgWaitTime' => $wait + 10, 'throughputPerMin' => 55, 'clearedTotal' => 1650],
                'post' => ['avgWaitTime' => 25, 'throughputPerMin' => 61, 'clearedTotal' => 2850],
                'stage1' => ['avgWaitTime' => $wait + 20, 'throughputPerMin' => 50, 'clearedTotal' => 750],
                'stage2' => ['avgWaitTime' => $wait, 'throughputPerMin' => 60, 'clearedTotal' => 900],
            ],
            'restoreSeconds' => $restoreSeconds,
            'postRestoreWindowS' => $windowS,
            'timeToRecoverySeconds' => 200,
            'timeToRecoveryWaitSeconds' => 300,
        ];
    }

    private function storeRun(string $batchId, int $seed, string $mode, float $zone2Wait): void
    {
        $this->postJson(route('simulation-runs.store'), ['runs' => [[
            'batch_id' => $batchId,
            'seed' => $seed,
            'controller_mode' => $mode,
            'sensor_mode' => $mode === 'fixed' ? null : 'camera',
            'power_state' => 'rolling_blackout',
            'corridor_config' => 'hatfield-realistic',
            'avg_wait_time' => 40,
            'avg_wait_time_arterial' => 40,
            'avg_wait_time_side_street' => 40,
            'throughput_per_min' => 170,
            'throughput_per_min_arterial' => 150,
            'throughput_per_min_side_street' => 100,
            'pct_cleared_without_stop' => 8,
            'pct_cleared_without_stop_arterial' => 24,
            'pct_cleared_without_stop_side_street' => 25,
            'avg_wait_time_stage1' => 55,
            'raw_config_json' => [
                'durationTicks' => 54000,
                'dt' => 0.1,
                'rollingSchedule' => [['zones' => [1, 3], 'fromTick' => 9000, 'toTick' => 18000], ['zones' => [2], 'fromTick' => 18000, 'toTick' => 27000]],
                'zoneAccounting' => 'by-junction-v1',
            ],
            'zone_stats' => [
                'zone1' => $this->zone(30, 1800, 3600),
                'zone2' => $this->zone($zone2Wait, 2700, 2700),
                'zone3' => $this->zone(30, 1800, 3600),
            ],
        ]]])->assertCreated();
    }

    public function test_zone_scopes_are_paired_on_the_same_seeds_from_zone_stats(): void
    {
        $batchId = (string) Str::uuid();
        foreach ([1, 2, 3] as $seed) {
            $this->storeRun($batchId, $seed, 'fixed', 40 + $seed);
            $this->storeRun($batchId, $seed, 'green_wave', 30 + $seed);
        }

        $payload = $this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->json();

        $comparison = collect($payload['pairedComparisons'])->first(fn (array $c): bool => $c['mode'] === 'green_wave' && $c['scope'] === 'zone2');
        $this->assertSame('rolling_blackout', $comparison['power_state']);
        // Per seed 30+s against 40+s: a constant 10 s gap on a 42 s fixed-time mean.
        $this->assertEquals(-23.8, $comparison['wait_delta_pct']);
        $this->assertEquals(0.0, $comparison['wait_delta_ci95_pct']);
        $this->assertSame(3, $comparison['paired_seeds']);
        $this->assertEquals(0.0, $comparison['throughput_delta_pct']);

        $fixed = collect($payload['aggregates'])->firstWhere('controller_mode', 'fixed');
        $this->assertEquals(42.0, $fixed['avg_wait_time_zone2']);
        $this->assertEquals(62.0, $fixed['avg_wait_time_stage1_zone2']);
        $this->assertEquals(52.0, $fixed['avg_wait_time_during_outage_zone2']);
        $this->assertSame(3, $fixed['time_to_recovery_seconds_zone2_recovered']);
        $this->assertEquals(430.0, $fixed['worst_wait_time_zone2']);
        $this->assertEquals(2700.0, $fixed['restore_seconds_zone2']);
        $this->assertEquals(55.0, $fixed['avg_wait_time_stage1']);
    }

    public function test_the_batch_stamp_carries_the_rolling_schedule_and_each_scopes_post_restore_window(): void
    {
        $batchId = (string) Str::uuid();
        $this->storeRun($batchId, 1, 'fixed', 40);

        $stamp = $this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->json('batchStamp');

        $this->assertEquals([['zones' => [1, 3], 'fromS' => 900, 'toS' => 1800], ['zones' => [2], 'fromS' => 1800, 'toS' => 2700]], $stamp['rollingSchedule']);
        $this->assertSame('by-junction-v1', $stamp['zoneAccounting']);
        $this->assertEquals(
            ['total' => 2700, 'arterial' => 2700, 'side_street' => 2700, 'zone1' => 3600, 'zone2' => 2700, 'zone3' => 3600],
            $stamp['postRestoreWindowSByScope']['rolling_blackout']
        );
        $this->assertEquals(1800, $stamp['restoreSecondsByScope']['rolling_blackout']['zone1']);
        $this->assertArrayNotHasKey('load_shedding', $stamp['postRestoreWindowSByScope']);
    }
}
