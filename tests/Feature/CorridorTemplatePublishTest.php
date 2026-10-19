<?php

namespace Tests\Feature;

use App\Models\User;
use App\Support\CorridorRepository;
use App\Support\UserCorridorLayouts;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CorridorTemplatePublishTest extends TestCase
{
    use RefreshDatabase;

    private string $directory;

    protected function setUp(): void
    {
        parent::setUp();

        $this->directory = sys_get_temp_dir().DIRECTORY_SEPARATOR.'corridor-publish-'.uniqid();
        mkdir($this->directory);
        file_put_contents($this->directory.'/'.UserCorridorLayouts::DEFAULT_TEMPLATE.'.json', json_encode(['id' => UserCorridorLayouts::DEFAULT_TEMPLATE, 'name' => 'Standard']));
        $this->app->instance(CorridorRepository::class, new CorridorRepository($this->directory));
    }

    protected function tearDown(): void
    {
        array_map('unlink', glob($this->directory.DIRECTORY_SEPARATOR.'*.json') ?: []);
        rmdir($this->directory);

        parent::tearDown();
    }

    private function layoutFor(User $user, string $slug, array $config): void
    {
        $decoded = json_decode(json_encode($config), false);
        $user->corridorLayouts()->create(['slug' => $slug, 'name' => $slug, 'config' => $decoded, 'original_config' => $decoded]);
    }

    public function test_publishing_overwrites_the_template_with_the_saved_layout(): void
    {
        $user = User::factory()->create();
        file_put_contents($this->directory.'/grid.json', json_encode(['id' => 'grid', 'name' => 'Old', 'meta' => new \stdClass]));
        $this->layoutFor($user, 'grid', ['id' => 'grid', 'name' => 'New', 'meta' => new \stdClass]);

        $this->actingAs($user)
            ->postJson(route('corridors.publish-template', ['corridor' => 'grid']))
            ->assertOk()
            ->assertJson(['published' => true]);

        $written = file_get_contents($this->directory.'/grid.json');
        $this->assertSame('New', json_decode($written)->name);
        $this->assertStringContainsString('"meta": {}', $written);
        $this->assertStringEndsWith("}\n", $written);
    }

    public function test_publishing_keeps_the_template_files_key_order(): void
    {
        $user = User::factory()->create();
        file_put_contents($this->directory.'/grid.json', '{"id":"grid","zeta":1,"alpha":{"y":1,"x":2},"items":[{"id":"b","q":1,"p":2}]}');
        $this->layoutFor($user, 'grid', ['id' => 'grid', 'alpha' => ['x' => 2, 'y' => 1], 'zeta' => 1, 'extra' => true, 'items' => [['id' => 'b', 'p' => 2, 'q' => 1]]]);

        $this->actingAs($user)->postJson(route('corridors.publish-template', ['corridor' => 'grid']))->assertOk();

        $this->assertSame(['id', 'zeta', 'alpha', 'items', 'extra'], array_keys(json_decode(file_get_contents($this->directory.'/grid.json'), true)));
        $written = json_decode(file_get_contents($this->directory.'/grid.json'), true);
        $this->assertSame(['y', 'x'], array_keys($written['alpha']));
        $this->assertSame(['id', 'q', 'p'], array_keys($written['items'][0]));
    }

    public function test_publishing_without_a_template_of_that_id_is_not_found(): void
    {
        $user = User::factory()->create();
        $this->layoutFor($user, 'grid', ['id' => 'grid', 'name' => 'New']);

        $this->actingAs($user)
            ->postJson(route('corridors.publish-template', ['corridor' => 'grid']))
            ->assertNotFound();

        $this->assertFileDoesNotExist($this->directory.'/grid.json');
    }

    public function test_another_users_layout_cannot_be_published(): void
    {
        file_put_contents($this->directory.'/grid.json', json_encode(['id' => 'grid', 'name' => 'Old']));
        $this->layoutFor(User::factory()->create(), 'grid', ['id' => 'grid', 'name' => 'Theirs']);

        $this->actingAs(User::factory()->create())
            ->postJson(route('corridors.publish-template', ['corridor' => 'grid']))
            ->assertNotFound();

        $this->assertSame('Old', json_decode(file_get_contents($this->directory.'/grid.json'))->name);
    }
}
