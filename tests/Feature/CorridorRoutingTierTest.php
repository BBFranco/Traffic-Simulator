<?php

namespace Tests\Feature;

use App\Models\CorridorLayout;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class CorridorRoutingTierTest extends TestCase
{
    use RefreshDatabase;

    private const GRID = <<<'JSON'
{
  "id": "grid",
  "name": "Grid · test",
  "arterials": [
    { "id": "main", "lanes": 2, "intersections": [{ "id": "n1", "distanceToNextM": 200 }, { "id": "n2", "distanceToNextM": null }] }
  ],
  "connectors": [],
  "routing": {
    "mode": "random",
    "blocks": [
      { "id": "MAIN-1", "from": "n1", "to": "n2", "tier": 2, "provisional": true },
      { "id": "MAIN-2", "from": "n2", "to": "main:end", "tier": 1.5 }
    ]
  }
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

    private function saveTiers(array $tiers): TestResponse
    {
        return $this->actingAs($this->user)->putJson(route('corridors.routing-tiers.update', ['corridor' => 'grid']), ['tiers' => $tiers]);
    }

    /** @return array<int, array<string, mixed>> */
    private function savedBlocks(): array
    {
        return json_decode(json_encode($this->layout->fresh()->config), true)['routing']['blocks'];
    }

    public function test_saving_sets_the_tier_and_clears_provisional(): void
    {
        $this->saveTiers([['id' => 'MAIN-1', 'tier' => 4]])
            ->assertOk()
            ->assertJson(['hasEdits' => true]);

        $blocks = $this->savedBlocks();

        $this->assertSame(['id' => 'MAIN-1', 'from' => 'n1', 'to' => 'n2', 'tier' => 4], $blocks[0]);
        $this->assertSame(1.5, $blocks[1]['tier']);
    }

    public function test_a_fractional_tier_is_stored_as_a_number(): void
    {
        $this->saveTiers([['id' => 'MAIN-1', 'tier' => '1.5']])->assertOk();

        $this->assertSame(1.5, $this->savedBlocks()[0]['tier']);
    }

    public function test_reverting_puts_the_tiers_back(): void
    {
        $this->saveTiers([['id' => 'MAIN-1', 'tier' => 5]])->assertOk();

        $this->actingAs($this->user)
            ->deleteJson(route('corridors.lane-use.destroy', ['corridor' => 'grid']))
            ->assertOk();

        $this->assertEquals(json_decode(self::GRID), $this->layout->fresh()->config);
    }

    public function test_a_tier_off_the_scale_is_rejected(): void
    {
        $this->saveTiers([['id' => 'MAIN-1', 'tier' => 2.5]])->assertUnprocessable()->assertJsonValidationErrors('tiers.0.tier');

        $this->assertFalse($this->layout->fresh()->hasEdits());
    }

    public function test_an_unknown_block_is_rejected_and_nothing_is_written(): void
    {
        $this->saveTiers([['id' => 'MAIN-1', 'tier' => 3], ['id' => 'NOPE-1', 'tier' => 3]])->assertUnprocessable();

        $this->assertFalse($this->layout->fresh()->hasEdits());
    }

    public function test_a_layout_without_routing_is_rejected(): void
    {
        $config = json_decode(self::GRID, false);
        unset($config->routing);
        $this->layout->update(['config' => $config, 'original_config' => $config]);

        $this->saveTiers([['id' => 'MAIN-1', 'tier' => 3]])->assertUnprocessable();
    }

    private function saveEdits(array $edits): TestResponse
    {
        return $this->actingAs($this->user)->putJson(route('corridors.routing-tiers.update', ['corridor' => 'grid']), $edits);
    }

    public function test_a_destination_can_be_added_on_an_inlet(): void
    {
        $this->saveEdits(['add' => [['id' => 'MAIN-0', 'from' => 'main:start', 'to' => 'n1', 'tier' => 3]]])->assertOk();

        $this->assertSame(['id' => 'MAIN-0', 'from' => 'main:start', 'to' => 'n1', 'tier' => 3], $this->savedBlocks()[2]);
    }

    public function test_a_destination_can_be_removed_alongside_other_edits(): void
    {
        $this->saveEdits(['remove' => ['MAIN-2'], 'tiers' => [['id' => 'MAIN-1', 'tier' => 5]]])->assertOk();

        $blocks = $this->savedBlocks();
        $this->assertCount(1, $blocks);
        $this->assertSame(5, $blocks[0]['tier']);
    }

    public function test_an_added_block_needs_known_points_and_a_free_id(): void
    {
        $this->saveEdits(['add' => [['id' => 'MAIN-9', 'from' => 'n1', 'to' => 'nowhere:end', 'tier' => 2]]])->assertUnprocessable();
        $this->saveEdits(['add' => [['id' => 'MAIN-1', 'from' => 'main:start', 'to' => 'n1', 'tier' => 2]]])->assertUnprocessable();
        $this->saveEdits(['add' => [['id' => 'bad id!', 'from' => 'main:start', 'to' => 'n1', 'tier' => 2]]])->assertUnprocessable();

        $this->assertFalse($this->layout->fresh()->hasEdits());
    }

    public function test_an_empty_edit_is_rejected(): void
    {
        $this->saveEdits([])->assertUnprocessable();
    }

    public function test_another_users_layout_cannot_be_edited(): void
    {
        $this->actingAs(User::factory()->create())
            ->putJson(route('corridors.routing-tiers.update', ['corridor' => 'grid']), ['tiers' => [['id' => 'MAIN-1', 'tier' => 3]]])
            ->assertNotFound();

        $this->assertFalse($this->layout->fresh()->hasEdits());
    }
}
