<?php

namespace Tests\Feature;

use App\Models\CorridorLayout;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class CorridorSlipLaneTest extends TestCase
{
    use RefreshDatabase;

    private const GRID = <<<'JSON'
{
  "id": "grid",
  "name": "Grid · test",
  "arterials": [
    { "id": "main", "lanes": 2, "direction": "eastbound", "oneWay": false, "intersections": [{ "id": "n1", "distanceToNextM": 200 }, { "id": "n2", "distanceToNextM": null, "slipLanes": [{ "direction": "westbound", "backM": 12 }] }] }
  ],
  "connectors": [
    { "id": "cross", "lanes": 2, "twoWay": true, "linksArterialNodes": ["n1"] },
    { "id": "slip_n2_westbound", "mode": "fixed", "name": "", "curve": [{ "xM": 0, "yM": 0 }, { "xM": 1, "yM": 1 }, { "xM": 2, "yM": 2 }], "lanes": 1, "twoWay": false, "turnChance": 0, "crossChance": 0, "targetSpeedKph": 30 }
  ],
  "joins": [
    { "from": "main:rev", "to": "slip_n2_westbound:fwd", "fromAtM": 10, "slip": true },
    { "from": "slip_n2_westbound:fwd", "to": "cross:fwd", "toAtM": 40 }
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

    private function saveSlipLanes(array $slipLanes, array $connectors, array $joins): TestResponse
    {
        return $this->actingAs($this->user)->putJson(route('corridors.slip-lanes.update', ['corridor' => 'grid']), [
            'slipLanes' => $slipLanes,
            'connectors' => $connectors,
            'joins' => $joins,
        ]);
    }

    /** @return array<string, mixed> */
    private function savedConfig(): array
    {
        return json_decode(json_encode($this->layout->fresh()->config), true);
    }

    private function slipConnector(string $id): array
    {
        return ['id' => $id, 'mode' => 'fixed', 'name' => '', 'curve' => [['xM' => 5, 'yM' => 5], ['xM' => 6, 'yM' => 6], ['xM' => 7, 'yM' => 7]], 'lanes' => 1, 'twoWay' => false, 'turnChance' => 0, 'crossChance' => 0, 'targetSpeedKph' => 30];
    }

    public function test_saving_replaces_every_slip_lane(): void
    {
        $this->saveSlipLanes(
            [['nodeId' => 'n1', 'direction' => 'eastbound', 'backM' => 14.2]],
            [$this->slipConnector('slip_n1_eastbound')],
            [
                ['from' => 'main', 'to' => 'slip_n1_eastbound:fwd', 'fromAtM' => 50.5, 'slip' => true],
                ['from' => 'slip_n1_eastbound:fwd', 'to' => 'cross:rev', 'toAtM' => 45.5],
            ],
        )->assertOk()->assertJson(['hasEdits' => true]);

        $config = $this->savedConfig();

        $this->assertSame(['cross', 'slip_n1_eastbound'], collect($config['connectors'])->pluck('id')->all());
        $this->assertSame([['direction' => 'eastbound', 'backM' => 14.2]], $config['arterials'][0]['intersections'][0]['slipLanes']);
        $this->assertArrayNotHasKey('slipLanes', $config['arterials'][0]['intersections'][1]);
        $this->assertSame(['main', 'slip_n1_eastbound:fwd'], collect($config['joins'])->pluck('from')->all());
    }

    public function test_an_empty_set_removes_the_slip_lanes(): void
    {
        $this->saveSlipLanes([], [], [])->assertOk();

        $config = $this->savedConfig();

        $this->assertSame(['cross'], collect($config['connectors'])->pluck('id')->all());
        $this->assertSame([], $config['joins']);
        $this->assertArrayNotHasKey('slipLanes', $config['arterials'][0]['intersections'][1]);
    }

    public function test_an_unknown_node_is_rejected_and_nothing_is_written(): void
    {
        $this->saveSlipLanes([['nodeId' => 'nope', 'direction' => 'eastbound', 'backM' => 10]], [$this->slipConnector('slip_nope_eastbound')], [])
            ->assertUnprocessable();

        $this->assertFalse($this->layout->fresh()->hasEdits());
    }

    public function test_connectors_must_match_the_listed_slip_lanes(): void
    {
        $this->saveSlipLanes([['nodeId' => 'n1', 'direction' => 'eastbound', 'backM' => 10]], [$this->slipConnector('slip_n2_eastbound')], [])
            ->assertUnprocessable();

        $this->assertFalse($this->layout->fresh()->hasEdits());
    }

    public function test_a_join_must_touch_a_slip_road_and_name_known_roads(): void
    {
        $slipLanes = [['nodeId' => 'n1', 'direction' => 'eastbound', 'backM' => 10]];
        $connectors = [$this->slipConnector('slip_n1_eastbound')];

        $this->saveSlipLanes($slipLanes, $connectors, [['from' => 'main', 'to' => 'cross:fwd']])->assertUnprocessable();
        $this->saveSlipLanes($slipLanes, $connectors, [['from' => 'slip_n1_eastbound:fwd', 'to' => 'nowhere:fwd', 'toAtM' => 3]])->assertUnprocessable();

        $this->assertFalse($this->layout->fresh()->hasEdits());
    }

    public function test_a_connector_that_is_not_a_slip_road_is_rejected(): void
    {
        $this->saveSlipLanes([], [$this->slipConnector('cross')], [])->assertUnprocessable()->assertJsonValidationErrors('connectors.0.id');
    }

    public function test_another_users_layout_is_not_found(): void
    {
        $this->actingAs(User::factory()->create())
            ->putJson(route('corridors.slip-lanes.update', ['corridor' => 'grid']), ['slipLanes' => [], 'connectors' => [], 'joins' => []])
            ->assertNotFound();
    }
}
