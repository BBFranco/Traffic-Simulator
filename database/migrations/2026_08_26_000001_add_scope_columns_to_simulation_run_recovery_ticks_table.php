<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Same three-scope split as simulation_runs' own scope migration, but for the
 * per-tick recovery series: the existing unsuffixed columns become the Total
 * (arterial + side streets) reading, and this adds the Arterial-only and
 * Side-Streets-only counterparts. This table is delete-then-insert per
 * condition (RecoveryTickController::store()), so there's no stale-row
 * concern here - the next "Generate dataset" run replaces every row cleanly.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
            $table->float('throughput_per_min_arterial')->nullable();
            $table->float('throughput_per_min_side_street')->nullable();
            $table->float('avg_wait_time_arterial')->nullable();
            $table->float('avg_wait_time_side_street')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
            $table->dropColumn([
                'throughput_per_min_arterial',
                'throughput_per_min_side_street',
                'avg_wait_time_arterial',
                'avg_wait_time_side_street',
            ]);
        });
    }
};
