<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * `time_to_recovery_seconds*` (added by the create-table migration) tracks THROUGHPUT
 * returning to its pre-outage baseline, not wait time, despite the results page's original
 * "seconds back to pre-cut wait" caption. This adds a genuinely wait-based counterpart in the
 * same three scopes, computed by runHeadless.js's computeRecoverySeconds() with a wait-suited
 * (lower-is-better) threshold direction. Nullable for the same reason as the throughput
 * columns: null on a normal-power run, and pre-migration rows have no way to backfill it.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->float('time_to_recovery_wait_seconds')->nullable();
            $table->float('time_to_recovery_wait_seconds_arterial')->nullable();
            $table->float('time_to_recovery_wait_seconds_side_street')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn([
                'time_to_recovery_wait_seconds',
                'time_to_recovery_wait_seconds_arterial',
                'time_to_recovery_wait_seconds_side_street',
            ]);
        });
    }
};
