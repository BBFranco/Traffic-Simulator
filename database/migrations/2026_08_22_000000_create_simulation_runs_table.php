<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One row per completed batch run (summary metrics only - per-tick data stays
 * in the headless runner's CSV export, build step 13). See Phase 2 spec
 * "Database schema" for the full rationale.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('simulation_runs', function (Blueprint $table) {
            $table->id();
            $table->integer('seed');
            $table->enum('controller_mode', ['fixed', 'adaptive', 'green_wave']);
            $table->enum('power_state', ['normal', 'load_shedding']);
            // Null for fixed-time, which never reads sensors.
            $table->enum('sensor_mode', ['inductive_loop', 'radar', 'camera', 'magnetometer'])->nullable();
            $table->string('corridor_config');
            $table->float('avg_wait_time');
            $table->float('throughput_per_min');
            $table->float('pct_cleared_without_stop');
            // Null if power_state = normal.
            $table->float('time_to_recovery_seconds')->nullable();
            $table->json('raw_config_json');
            // A run is an immutable summary record - no updated_at to maintain.
            $table->timestamp('created_at')->useCurrent();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('simulation_runs');
    }
};
