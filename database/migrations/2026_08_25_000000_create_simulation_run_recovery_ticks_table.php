<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Per-tick throughput and avg-wait series for one representative load-shedding
 * run per (controller_mode, sensor_mode) - what the /results page's "Recovery
 * after a power cut" line charts plot. `simulation_runs` only stores one summary row
 * per run, so this is the DB-backed replacement for the CLI batch runner's
 * per-run CSV export, which the browser-driven "Generate dataset" button can
 * never produce (it does no filesystem I/O). A fresh "Generate dataset" run
 * replaces a condition's rows outright (delete-then-insert in
 * RecoveryTickController::store()) rather than accumulating alongside stale
 * ones.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('simulation_run_recovery_ticks', function (Blueprint $table) {
            $table->id();
            $table->enum('controller_mode', ['fixed', 'adaptive', 'green_wave']);
            // Null for fixed and green-wave, which never vary by sensor (see
            // simulation_runs' own sensor_mode column docblock).
            $table->enum('sensor_mode', ['inductive_loop', 'radar', 'camera', 'magnetometer'])->nullable();
            $table->integer('tick');
            $table->float('seconds');
            $table->float('throughput_per_min');
            $table->float('avg_wait_time');
            // Repeated on every row of a condition's series (cheap, avoids a second table)
            // so the chart can shade the outage window without re-deriving it from ticks.
            $table->float('power_event_seconds');
            $table->timestamp('created_at')->useCurrent();

            $table->index(['controller_mode', 'sensor_mode']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('simulation_run_recovery_ticks');
    }
};
