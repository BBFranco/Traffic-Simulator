<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Adds the columns behind the results-page audit's two remaining fixes:
 *
 *  - Pre-outage / during-outage / post-recovery segmented wait and throughput
 *    (Total scope only) - computed from cumulative counters, not the 60s
 *    rolling window `avg_wait_time`/`throughput_per_min` used to read from.
 *    Null on a normal-power run, which has no outage to segment.
 *  - Full-run median/p95/max wait (Total scope only, network-wide) - a mean
 *    alone can't tell "everyone waits a bit longer" apart from "most people
 *    are fine, a few are stranded".
 *
 * All nullable: existing rows (and any row from a normal-power condition)
 * simply don't have a value.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->float('avg_wait_time_pre_outage')->nullable();
            $table->float('avg_wait_time_during_outage')->nullable();
            $table->float('avg_wait_time_post_recovery')->nullable();
            $table->float('throughput_per_min_pre_outage')->nullable();
            $table->float('throughput_per_min_during_outage')->nullable();
            $table->float('throughput_per_min_post_recovery')->nullable();
            $table->float('median_wait_time')->nullable();
            $table->float('p95_wait_time')->nullable();
            $table->float('max_wait_time')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn([
                'avg_wait_time_pre_outage',
                'avg_wait_time_during_outage',
                'avg_wait_time_post_recovery',
                'throughput_per_min_pre_outage',
                'throughput_per_min_during_outage',
                'throughput_per_min_post_recovery',
                'median_wait_time',
                'p95_wait_time',
                'max_wait_time',
            ]);
        });
    }
};
