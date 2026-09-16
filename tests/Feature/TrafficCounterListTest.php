<?php

namespace Tests\Feature;

use App\Models\TrafficCount;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class TrafficCounterListTest extends TestCase
{
    use RefreshDatabase;

    private function makeCount(array $overrides = []): TrafficCount
    {
        return TrafficCount::query()->create(array_merge([
            'corridor_config' => 'hatfield',
            'street' => 'francis-baard',
            'label' => 'Test count',
            'line_coords_json' => [['x' => 0, 'y' => 0], ['x' => 10, 'y' => 10]],
            'status' => 'done',
        ], $overrides));
    }

    public function test_index_shows_only_the_last_ten_counts_with_no_pagination(): void
    {
        $user = User::factory()->create();
        for ($i = 0; $i < 15; $i++) {
            $this->makeCount(['label' => "Count {$i}"]);
        }

        $response = $this->actingAs($user)->get('/traffic-counter');

        $response->assertOk();
        $counts = $response->viewData('recentCounts');
        $this->assertCount(10, $counts);
        $this->assertSame('Count 14', $counts->first()->label);
    }

    public function test_list_endpoint_paginates_all_counts_twenty_per_page_with_full_columns(): void
    {
        $user = User::factory()->create();
        for ($i = 0; $i < 25; $i++) {
            $this->makeCount(['label' => "Count {$i}", 'mean_flow' => 12.5]);
        }

        $firstPage = $this->actingAs($user)->getJson('/api/traffic-counts');
        $firstPage->assertOk();
        $firstPage->assertJsonPath('current_page', 1);
        $firstPage->assertJsonPath('last_page', 2);
        $this->assertCount(20, $firstPage->json('data'));
        $this->assertSame(12.5, $firstPage->json('data.0.mean_flow'));

        $secondPage = $this->actingAs($user)->getJson('/api/traffic-counts?page=2');
        $secondPage->assertOk();
        $secondPage->assertJsonPath('current_page', 2);
        $this->assertCount(5, $secondPage->json('data'));
    }

    public function test_destroy_deletes_row_and_stored_video_files(): void
    {
        Storage::fake('local');
        Storage::disk('local')->put('traffic-counts/video.mp4', 'fake-video');
        Storage::disk('local')->put('traffic-counts/annotated.mp4', 'fake-annotated');

        $user = User::factory()->create();
        $count = $this->makeCount([
            'video_path' => 'traffic-counts/video.mp4',
            'annotated_video_path' => 'traffic-counts/annotated.mp4',
        ]);

        $response = $this->actingAs($user)->deleteJson("/api/traffic-counts/{$count->id}");

        $response->assertOk();
        $response->assertJsonPath('deleted', true);
        $this->assertDatabaseMissing('traffic_counts', ['id' => $count->id]);
        Storage::disk('local')->assertMissing('traffic-counts/video.mp4');
        Storage::disk('local')->assertMissing('traffic-counts/annotated.mp4');
    }

    public function test_destroy_without_stored_files_does_not_error(): void
    {
        $user = User::factory()->create();
        $count = $this->makeCount(['video_path' => null, 'annotated_video_path' => null]);

        $response = $this->actingAs($user)->deleteJson("/api/traffic-counts/{$count->id}");

        $response->assertOk();
        $this->assertDatabaseMissing('traffic_counts', ['id' => $count->id]);
    }
}
