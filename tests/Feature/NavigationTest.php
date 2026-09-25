<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * The Phase 1 milestone, as a test: log in, land on /simulator, see the road and
 * every control, switch to /results, see the charts, log out - nothing broken and
 * no dead links.
 *
 * Phase 2 is not allowed to break any of this; it only replaces what sits behind
 * the controls these assertions look for.
 */
class NavigationTest extends TestCase
{
    use RefreshDatabase;

    public function test_guests_see_the_landing_page(): void
    {
        $this->get('/')
            ->assertOk()
            ->assertSee('Log in')
            ->assertSee('ARTIS');
    }

    public function test_guests_are_redirected_away_from_the_app_pages(): void
    {
        $this->get('/simulator')->assertRedirect('/login');
        $this->get('/results')->assertRedirect('/login');
        $this->get('/corridors/hatfield-pretorius-francisbaard')->assertRedirect('/login');
    }

    public function test_logging_in_lands_on_the_simulator(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)->get('/dashboard')->assertRedirect(route('simulator'));
        $this->actingAs($user)->get('/')->assertRedirect(route('simulator'));
    }

    public function test_the_simulator_page_renders_the_layout_and_every_control(): void
    {
        $response = $this->actingAs(User::factory()->create())->get('/simulator');

        $response->assertOk()
            // Canvas plus its boot payload.
            ->assertSee('id="sim-canvas"', false)
            ->assertSee('id="sim-boot"', false)
            ->assertSee('Hatfield Pretorius / Francis Baard Grid')
            // Scenario + seed.
            ->assertSee('id="corridor-select"', false)
            ->assertSee('id="seed-input"', false)
            // Controller mode, sensing, power, run controls.
            ->assertSee('name="sensorMode"', false)
            ->assertSee('id="load-shedding-toggle"', false)
            ->assertSee('id="scheduled-outages"', false)
            ->assertSee('id="battery-backed-sensors"', false)
            ->assertSee('id="run-toggle"', false)
            ->assertSee('id="step-button"', false)
            ->assertSee('id="reset-button"', false)
            ->assertSee('data-segmented="speed"', false)
            // Stats footer scaffolding and its live chart.
            ->assertSee('id="stats-columns"', false)
            ->assertSee('id="stats-chart"', false)
            ->assertSee('Cleared all lights without stopping');

        // All five sensor models from the spec's table are offered.
        foreach (['none', 'inductive_loop', 'radar', 'camera', 'magnetometer'] as $sensor) {
            $response->assertSee('value="'.$sensor.'"', false);
        }
    }

    public function test_corridor_configs_are_served_as_json(): void
    {
        $response = $this->actingAs(User::factory()->create())
            ->getJson('/corridors/hatfield-pretorius-francisbaard');

        $response->assertOk()
            ->assertJsonPath('id', 'hatfield-pretorius-francisbaard')
            ->assertJsonCount(2, 'arterials')
            ->assertJsonCount(4, 'connectors')
            ->assertJsonPath('arterials.0.intersections.0.id', 'fb_1');
    }

    public function test_every_corridor_template_on_disk_loads(): void
    {
        $user = User::factory()->create();

        foreach (['hatfield-pretorius-francisbaard', 'hatfield-realistic', 'hatfield-turn-lanes', 'two-intersection-test', 'single-intersection'] as $id) {
            $this->actingAs($user)->getJson("/corridor-templates/{$id}")->assertOk()->assertJsonPath('id', $id);
        }
    }

    public function test_an_unknown_corridor_is_a_404(): void
    {
        $this->actingAs(User::factory()->create())
            ->getJson('/corridors/does-not-exist')
            ->assertNotFound();
    }

    public function test_the_results_page_renders_the_charts_and_the_table_twins(): void
    {
        $response = $this->actingAs(User::factory()->create())->get('/results');

        $response->assertOk()
            ->assertSee('No data yet')
            ->assertSee('Does ITS beat the fixed-time baseline?')
            // One canvas per chart.
            ->assertSee('id="chart-wait"', false)
            ->assertSee('id="chart-throughput"', false)
            ->assertSee('id="chart-cleared"', false)
            ->assertSee('id="chart-recovery"', false)
            ->assertSee('id="chart-recovery-time"', false)
            // Chart data payload and the accessible table equivalents.
            ->assertSee('id="results-data"', false)
            ->assertSee('Show data table')
            ->assertSee('Recent runs')
            // The single filter row that scopes the page.
            ->assertSee('id="filter-corridor"', false);
    }

    public function test_the_theme_defaults_to_light_and_the_header_offers_a_toggle(): void
    {
        $user = User::factory()->create();

        foreach (['/simulator', '/results'] as $path) {
            $response = $this->actingAs($user)->get($path);

            $response->assertOk()
                // The pre-paint script that avoids a flash of the wrong theme.
                ->assertSee("localStorage.getItem('theme')", false)
                // Light is the default: the OS preference must not be consulted.
                ->assertSee("var theme = 'light';", false)
                ->assertDontSee('prefers-color-scheme', false)
                // The toggle itself, in the header.
                ->assertSee('data-theme-toggle', false)
                ->assertSee('Switch to night mode', false);
        }

    }

    public function test_guest_pages_carry_the_theme_boot_script_too(): void
    {
        // So a stored night-mode choice survives logging out, rather than snapping
        // back to light on the login screen.
        foreach (['/', '/login', '/register'] as $path) {
            $this->get($path)
                ->assertOk()
                ->assertSee("localStorage.getItem('theme')", false)
                ->assertSee('data-theme-toggle', false);
        }
    }

    public function test_the_nav_links_both_pages_and_logging_out_works(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)->get('/simulator')
            ->assertOk()
            ->assertSee(route('simulator'), false)
            ->assertSee(route('results'), false)
            ->assertSee(route('logout'), false);

        $this->actingAs($user)->post('/logout')->assertRedirect('/');
        $this->assertGuest();
    }
}
