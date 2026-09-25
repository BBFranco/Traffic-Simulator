<?php

namespace Tests\Feature;

use App\Models\CorridorLayout;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class CorridorLaneUseTest extends TestCase
{
    use RefreshDatabase;

    private const GRID = <<<'JSON'
{
  "id": "grid",
  "name": "Grid · test",
  "meta": {},
  "arterials": [
    {
      "id": "main",
      "lanes": 3,
      "intersections": [
        { "id": "n1", "distanceToNextM": 200 },
        { "id": "n2", "distanceToNextM": null }
      ]
    }
  ],
  "connectors": [
    { "id": "side", "lanes": 4, "twoWay": true, "linksArterialNodes": ["n1", "n2"], "crossChance": 0.2 }
  ]
}
JSON;

    private User $user;

    private CorridorLayout $layout;

    protected function setUp(): void
    {
        parent::setUp();

        $this->user = User::factory()->create();
        $config = json_decode(self::GRID, false);
        $this->layout = $this->user->corridorLayouts()->create(['slug' => 'grid', 'name' => 'Grid · test', 'config' => $config, 'original_config' => $config]);
    }

    private function saveLaneUse(array $approaches): TestResponse
    {
        return $this->actingAs($this->user)->putJson(route('corridors.lane-use.update', ['corridor' => 'grid']), ['approaches' => $approaches]);
    }

    /** @return array<string, mixed> */
    private function savedConfig(): array
    {
        return json_decode(json_encode($this->layout->fresh()->config), true);
    }

    public function test_saving_writes_lane_use_into_the_layout_and_keeps_the_original(): void
    {
        $this->saveLaneUse([
            ['nodeId' => 'n1', 'key' => 'arterial', 'lanes' => ['left', 'straight', 'straight_right']],
            ['nodeId' => 'n2', 'key' => 'southbound', 'lanes' => ['left_straight', 'right']],
        ])
            ->assertOk()
            ->assertJson(['hasEdits' => true]);

        $config = $this->savedConfig();

        $this->assertSame(['left', 'straight', 'straight_right'], $config['arterials'][0]['intersections'][0]['laneUse']);
        $this->assertSame(['left_straight', 'right'], $config['connectors'][0]['laneUse']['n2']['southbound']);
        $this->assertStringContainsString('"meta":{}', json_encode($this->layout->fresh()->config));
        $this->assertEquals(json_decode(self::GRID), $this->layout->fresh()->original_config);
    }

    public function test_reverting_puts_the_layout_back_as_it_was_imported(): void
    {
        $this->saveLaneUse([['nodeId' => 'n1', 'key' => 'arterial', 'lanes' => ['left', 'straight', 'straight']]])->assertOk();
        $this->saveLaneUse([['nodeId' => 'n1', 'key' => 'arterial', 'lanes' => ['all', 'straight', 'straight']]])->assertOk();

        $this->actingAs($this->user)
            ->deleteJson(route('corridors.lane-use.destroy', ['corridor' => 'grid']))
            ->assertOk()
            ->assertJson(['hasEdits' => false]);

        $this->assertEquals(json_decode(self::GRID), $this->layout->fresh()->config);
    }

    public function test_reverting_with_no_saved_edits_is_a_conflict(): void
    {
        $this->actingAs($this->user)
            ->deleteJson(route('corridors.lane-use.destroy', ['corridor' => 'grid']))
            ->assertStatus(409);
    }

    public function test_another_users_layout_cannot_be_edited(): void
    {
        $this->actingAs(User::factory()->create())
            ->putJson(route('corridors.lane-use.update', ['corridor' => 'grid']), [
                'approaches' => [['nodeId' => 'n1', 'key' => 'arterial', 'lanes' => ['left', 'straight', 'straight']]],
            ])
            ->assertNotFound();

        $this->assertFalse($this->layout->fresh()->hasEdits());
    }

    public function test_a_wrong_lane_count_is_rejected_and_nothing_is_written(): void
    {
        $this->saveLaneUse([
            ['nodeId' => 'n1', 'key' => 'arterial', 'lanes' => ['left', 'straight', 'straight']],
            ['nodeId' => 'n2', 'key' => 'northbound', 'lanes' => ['left', 'straight', 'right']],
        ])->assertUnprocessable();

        $this->assertFalse($this->layout->fresh()->hasEdits());
    }

    public function test_saving_writes_turn_lanes_into_the_layout(): void
    {
        $this->saveLaneUse([
            ['nodeId' => 'n1', 'key' => 'arterial', 'lanes' => ['left', 'straight', 'straight'], 'turnLanes' => ['right' => ['lengthM' => 10, 'laneUse' => 'right']]],
            ['nodeId' => 'n2', 'key' => 'southbound', 'lanes' => ['left_straight', 'straight'], 'turnLanes' => ['left' => ['lengthM' => 25, 'laneUse' => 'left']]],
        ])->assertOk();

        $config = $this->savedConfig();

        $this->assertSame(['right' => ['lengthM' => 10, 'laneUse' => 'right']], $config['arterials'][0]['intersections'][0]['turnLanes']);
        $this->assertSame(['left' => ['lengthM' => 25, 'laneUse' => 'left']], $config['connectors'][0]['turnLanes']['n2']['southbound']);
    }

    public function test_empty_turn_lanes_remove_them_and_leaving_them_out_keeps_them(): void
    {
        $this->saveLaneUse([
            ['nodeId' => 'n1', 'key' => 'arterial', 'lanes' => ['left', 'straight', 'straight'], 'turnLanes' => ['left' => ['lengthM' => 10, 'laneUse' => 'left']]],
            ['nodeId' => 'n2', 'key' => 'southbound', 'lanes' => ['left_straight', 'straight'], 'turnLanes' => ['left' => ['lengthM' => 10, 'laneUse' => 'left']]],
        ])->assertOk();
        $this->saveLaneUse([
            ['nodeId' => 'n1', 'key' => 'arterial', 'lanes' => ['all', 'straight', 'straight']],
            ['nodeId' => 'n2', 'key' => 'southbound', 'lanes' => ['left_straight', 'straight'], 'turnLanes' => []],
        ])->assertOk();

        $config = $this->savedConfig();

        $this->assertSame(['left' => ['lengthM' => 10, 'laneUse' => 'left']], $config['arterials'][0]['intersections'][0]['turnLanes']);
        $this->assertArrayNotHasKey('turnLanes', $config['connectors'][0]);
    }

    public function test_a_right_turn_lane_on_an_undivided_two_way_street_is_rejected(): void
    {
        $this->saveLaneUse([
            ['nodeId' => 'n2', 'key' => 'southbound', 'lanes' => ['left_straight', 'straight'], 'turnLanes' => ['right' => ['lengthM' => 10, 'laneUse' => 'right']]],
        ])->assertUnprocessable();

        $this->assertFalse($this->layout->fresh()->hasEdits());
    }

    public function test_a_turn_lane_that_goes_straight_is_rejected(): void
    {
        $this->saveLaneUse([
            ['nodeId' => 'n1', 'key' => 'arterial', 'lanes' => ['left', 'straight', 'straight'], 'turnLanes' => ['middle' => ['lengthM' => 10, 'laneUse' => 'left'], 'left' => ['lengthM' => 10, 'laneUse' => 'straight']]],
        ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors(['approaches.0.turnLanes', 'approaches.0.turnLanes.left.laneUse']);
    }

    public function test_an_unknown_movement_is_rejected(): void
    {
        $this->saveLaneUse([['nodeId' => 'n1', 'key' => 'arterial', 'lanes' => ['left', 'uturn', 'straight']]])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('approaches.0.lanes.1');
    }
}
