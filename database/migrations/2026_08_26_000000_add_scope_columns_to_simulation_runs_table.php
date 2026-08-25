<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Splits every summary metric into three scopes: the existing unsuffixed
 * column now means "Total" (main arterial + side streets combined, going
 * forward), and this adds an `_arterial`-only and `_side_street`-only
 * counterpart for each. Nullable because rows inserted before this migration
 * never measured side-street traffic at all - they keep their old
 * (arterial-only) values under the unsuffixed columns and have no way to
 * backfill the new ones. Re-run the "Generate dataset" batch after migrating
 * to get fully-scoped rows.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->float('avg_wait_time_arterial')->nullable();
            $table->float('avg_wait_time_side_street')->nullable();
            $table->float('throughput_per_min_arterial')->nullable();
            $table->float('throughput_per_min_side_street')->nullable();
            $table->float('pct_cleared_without_stop_arterial')->nullable();
            $table->float('pct_cleared_without_stop_side_street')->nullable();
            $table->float('time_to_recovery_seconds_arterial')->nullable();
            $table->float('time_to_recovery_seconds_side_street')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn([
                'avg_wait_time_arterial',
                'avg_wait_time_side_street',
                'throughput_per_min_arterial',
                'throughput_per_min_side_street',
                'pct_cleared_without_stop_arterial',
                'pct_cleared_without_stop_side_street',
                'time_to_recovery_seconds_arterial',
                'time_to_recovery_seconds_side_street',
            ]);
        });
    }
};
