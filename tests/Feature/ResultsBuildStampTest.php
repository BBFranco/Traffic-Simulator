<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class ResultsBuildStampTest extends TestCase
{
    use RefreshDatabase;

    public static function stamps(): array
    {
        return [
            'clean CLI' => [['commit' => 'abc1234', 'dirty' => false, 'source' => 'cli', 'sim' => 'aaaaaaaaaaaa'], 'clean', 'code abc1234 (clean tree) via CLI, sim aaaaaaaaaaaa'],
            'dirty CLI' => [['commit' => 'abc1234', 'dirty' => true, 'source' => 'cli'], 'dirty', 'code abc1234 (uncommitted changes) via CLI'],
            'git status failed' => [['commit' => 'abc1234', 'dirty' => null, 'source' => 'cli'], 'unknown', 'code abc1234 (tree state unknown) via CLI'],
            'dirty flag missing' => [['commit' => 'abc1234', 'source' => 'vite-build'], 'unknown', 'code abc1234 (tree state unknown) via built bundle'],
            'dev server, baked stamp' => [['commit' => 'abc1234', 'dirty' => true, 'source' => 'vite-dev'], 'unchecked', 'code abc1234 (tree state not checked) via dev server'],
            'dev server, baked stamp claiming clean' => [['commit' => 'abc1234', 'dirty' => false, 'source' => 'vite-dev'], 'unchecked', 'code abc1234 (tree state not checked) via dev server'],
            'dev server, fresh clean stamp' => [['commit' => 'abc1234', 'dirty' => false, 'source' => 'vite-dev', 'fresh' => true], 'clean', 'code abc1234 (clean tree) via dev server'],
            'no git' => [['commit' => null, 'dirty' => null, 'source' => 'cli'], null, 'code commit not recorded via CLI'],
        ];
    }

    #[DataProvider('stamps')]
    public function test_the_tree_state_is_clean_only_when_checked(array $build, ?string $treeState, string $label): void
    {
        $this->postJson(route('simulation-runs.store'), ['runs' => [[
            'batch_id' => (string) Str::uuid(),
            'seed' => 1,
            'controller_mode' => 'fixed',
            'sensor_mode' => null,
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
            'raw_config_json' => ['durationTicks' => 36000, 'dt' => 0.1, 'build' => $build],
        ]]])->assertCreated();

        $stamp = $this->actingAs(User::factory()->create())
            ->getJson(route('results.data', ['routing' => 'random']))
            ->assertOk()
            ->json('batchStamp');

        $this->assertSame($treeState, $stamp['treeState']);
        $this->assertStringStartsWith($label.' · ', $stamp['label']);
    }
}
