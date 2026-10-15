<?php

namespace Tests\Feature;

use App\Models\SimulationRun;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class SensorSpecMetadataTest extends TestCase
{
    use RefreshDatabase;

    private function storeRun(string $batchId, string $mode, ?string $sensorMode, array $sensorSpec = []): TestResponse
    {
        return $this->postJson(route('simulation-runs.store'), ['runs' => [[
            'batch_id' => $batchId,
            'seed' => 1,
            'controller_mode' => $mode,
            'sensor_mode' => $sensorMode,
            'power_state' => 'normal',
            'corridor_config' => 'hatfield-realistic',
            'avg_wait_time' => 20,
            'avg_wait_time_arterial' => 15,
            'avg_wait_time_side_street' => 12,
            'throughput_per_min' => 170,
            'throughput_per_min_arterial' => 150,
            'throughput_per_min_side_street' => 100,
            'pct_cleared_without_stop' => 8,
            'pct_cleared_without_stop_arterial' => 24,
            'pct_cleared_without_stop_side_street' => 25,
            'raw_config_json' => ['durationTicks' => 36000, 'dt' => 0.1],
            ...$sensorSpec,
        ]]]);
    }

    private function batchStamp(): array
    {
        return $this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->json('batchStamp');
    }

    public function test_a_run_stores_its_sensor_spec_set_and_hash(): void
    {
        $batchId = (string) Str::uuid();
        $this->storeRun($batchId, 'fixed', null)->assertCreated();
        $this->storeRun($batchId, 'adaptive', 'radar', ['sensor_spec_set' => 'field', 'sensor_spec_hash' => 'd020d308dd3be8ce'])->assertCreated();

        $run = SimulationRun::query()->where('controller_mode', 'adaptive')->sole();
        $this->assertSame('field', $run->sensor_spec_set);
        $this->assertSame('d020d308dd3be8ce', $run->sensor_spec_hash);
        $this->assertNull(SimulationRun::query()->where('controller_mode', 'fixed')->sole()->sensor_spec_set);

        $stamp = $this->batchStamp();
        $this->assertStringContainsString('sensor specs field', $stamp['label']);
        $this->assertSame(['radar' => 'd020d308dd3be8ce'], $stamp['sensorSpecs']['hashes']);
    }

    public function test_runs_from_before_it_was_recorded_stay_unknown(): void
    {
        $this->storeRun((string) Str::uuid(), 'adaptive', 'camera')->assertCreated();

        $this->assertNull(SimulationRun::query()->sole()->sensor_spec_set);
        $stamp = $this->batchStamp();
        $this->assertStringContainsString('sensor specs not recorded', $stamp['label']);
        $this->assertSame([], $stamp['sensorSpecs']['sets']);
    }

    public function test_an_unknown_spec_set_or_malformed_hash_is_rejected(): void
    {
        $batchId = (string) Str::uuid();
        $this->storeRun($batchId, 'adaptive', 'radar', ['sensor_spec_set' => 'bench', 'sensor_spec_hash' => 'd020d308dd3be8ce'])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('runs.0.sensor_spec_set');
        $this->storeRun($batchId, 'adaptive', 'radar', ['sensor_spec_set' => 'field', 'sensor_spec_hash' => 'not-a-hash'])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('runs.0.sensor_spec_hash');
    }
}
