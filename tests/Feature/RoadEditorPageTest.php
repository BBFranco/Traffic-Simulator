<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class RoadEditorPageTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_road_editor_page_renders_with_the_corridor_picker(): void
    {
        $this->actingAs(User::factory()->create())
            ->get(route('road-editor'))
            ->assertOk()
            ->assertSee('editor-corridor-select', false)
            ->assertSee('road-editor-boot', false);
    }

    public function test_guests_are_sent_to_login(): void
    {
        $this->get(route('road-editor'))->assertRedirect(route('login'));
    }
}
