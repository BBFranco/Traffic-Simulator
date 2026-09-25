<?php

namespace Tests\Feature;

use App\Models\User;
use App\Support\UserCorridorLayouts;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Tests\TestCase;

class CorridorLayoutTest extends TestCase
{
    use RefreshDatabase;

    private const MINIMAL = '{"id":"my road","name":"My road","meta":{},"arterials":[{"id":"a","direction":"eastbound","lanes":2,"intersections":[{"id":"n1","distanceToNextM":null}]}],"connectors":[]}';

    private function upload(string $contents, string $name = 'my-road.json'): UploadedFile
    {
        return UploadedFile::fake()->createWithContent($name, $contents);
    }

    public function test_a_new_user_starts_with_the_standard_hatfield_layout(): void
    {
        $user = User::factory()->create();

        $this->assertSame([UserCorridorLayouts::DEFAULT_TEMPLATE], $user->corridorLayouts()->pluck('slug')->all());
        $this->actingAs($user)
            ->getJson(route('corridors.show', ['corridor' => UserCorridorLayouts::DEFAULT_TEMPLATE]))
            ->assertOk()
            ->assertJsonPath('id', UserCorridorLayouts::DEFAULT_TEMPLATE)
            ->assertJsonCount(2, 'arterials');
    }

    public function test_the_seeded_demo_account_gets_the_standard_layout_too(): void
    {
        $this->seed();

        $this->assertSame(
            [UserCorridorLayouts::DEFAULT_TEMPLATE],
            User::query()->where('email', 'demo@traffic-simulator.test')->first()->corridorLayouts()->pluck('slug')->all()
        );
    }

    public function test_layouts_are_scoped_to_their_owner(): void
    {
        $owner = User::factory()->create();
        $this->actingAs($owner)->post(route('corridors.store'), ['layout' => $this->upload(self::MINIMAL)])->assertCreated();

        $this->actingAs(User::factory()->create())
            ->getJson(route('corridors.show', ['corridor' => 'my-road']))
            ->assertNotFound();
        $this->actingAs(User::factory()->create())
            ->get(route('road-editor'))
            ->assertOk()
            ->assertDontSee('My road');
    }

    public function test_importing_adds_a_layout_under_a_unique_slug(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)
            ->post(route('corridors.store'), ['layout' => $this->upload(self::MINIMAL)], ['Accept' => 'application/json'])
            ->assertCreated()
            ->assertJsonPath('layout.id', 'my-road')
            ->assertJsonPath('layout.name', 'My road')
            ->assertJsonPath('layout.intersections', 1);
        $this->actingAs($user)
            ->post(route('corridors.store'), ['layout' => $this->upload(self::MINIMAL)], ['Accept' => 'application/json'])
            ->assertCreated()
            ->assertJsonPath('layout.id', 'my-road-2');

        $this->actingAs($user)
            ->getJson(route('corridors.show', ['corridor' => 'my-road-2']))
            ->assertOk()
            ->assertJsonPath('id', 'my-road-2');
        $this->assertStringContainsString('"meta":{}', json_encode($user->corridorLayouts()->where('slug', 'my-road')->first()->config));
    }

    public function test_a_file_that_is_not_a_road_layout_is_rejected(): void
    {
        $user = User::factory()->create();

        foreach (['not json at all', '{"roads":[]}', '{"arterials":[{"id":"a","intersections":[]}]}'] as $contents) {
            $this->actingAs($user)
                ->post(route('corridors.store'), ['layout' => $this->upload($contents)], ['Accept' => 'application/json'])
                ->assertUnprocessable()
                ->assertJsonValidationErrors('layout');
        }

        $this->assertSame(1, $user->corridorLayouts()->count());
    }

    public function test_a_layout_can_be_deleted_but_never_the_last_one(): void
    {
        $user = User::factory()->create();
        $this->actingAs($user)->post(route('corridors.store'), ['layout' => $this->upload(self::MINIMAL)])->assertCreated();

        $this->actingAs($user)
            ->deleteJson(route('corridors.destroy', ['corridor' => 'my-road']))
            ->assertOk()
            ->assertJson(['defaultCorridorId' => UserCorridorLayouts::DEFAULT_TEMPLATE]);
        $this->actingAs($user)
            ->deleteJson(route('corridors.destroy', ['corridor' => UserCorridorLayouts::DEFAULT_TEMPLATE]))
            ->assertStatus(409);

        $this->assertSame([UserCorridorLayouts::DEFAULT_TEMPLATE], $user->corridorLayouts()->pluck('slug')->all());
    }

    public function test_the_shared_templates_are_still_served_for_results(): void
    {
        $this->actingAs(User::factory()->create())
            ->getJson(route('corridor-templates.show', ['corridor' => 'hatfield-realistic']))
            ->assertOk()
            ->assertJsonPath('id', 'hatfield-realistic');
    }
}
