<?php

use App\Enums\PowerState;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Recovery curves per outage power state, so a rolling blackout's curve doesn't replace the total blackout's for the
 * same condition. Every earlier curve was a total blackout. `dark_windows` ([{zones (null = all), fromS, toS}]) lets a
 * chart shade each zone's own window.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
            $table->string('power_state', 32)->default(PowerState::LoadShedding->value)->after('routing_mode');
            $table->json('dark_windows')->nullable()->after('power_outage_end_seconds');
        });

        Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
            $table->dropIndex('recovery_ticks_corridor_mode_sensor_idx');
            $table->index(['corridor_config', 'routing_mode', 'power_state', 'controller_mode', 'sensor_mode'], 'recovery_ticks_condition_idx');
        });
    }

    public function down(): void
    {
        Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
            $table->dropIndex('recovery_ticks_condition_idx');
            $table->index(['corridor_config', 'controller_mode', 'sensor_mode'], 'recovery_ticks_corridor_mode_sensor_idx');
        });

        Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
            $table->dropColumn(['power_state', 'dark_windows']);
        });
    }
};
