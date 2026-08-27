<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Arterial/side-street counterparts of the pre-outage / during-outage /
 * post-recovery wait and throughput segments added by the previous migration
 * (which only added Total-scope columns). Without these, the "vs fixed-time"
 * cards' post-recovery sub-stat and the segmented table were stuck showing
 * Total-scope numbers even when Arterial/Side-Streets was selected - see the
 * results-page scope-filter audit. Median/p95/max wait distribution stays
 * Total-scope only; no scoped counterpart needed there.
 *
 * All nullable, same as the columns they extend: existing rows, and any
 * normal-power run (no outage to segment), simply don't have a value.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            foreach (['arterial', 'side_street'] as $scope) {
                foreach (['pre_outage', 'during_outage', 'post_recovery'] as $segment) {
                    $table->float("avg_wait_time_{$segment}_{$scope}")->nullable();
                    $table->float("throughput_per_min_{$segment}_{$scope}")->nullable();
                }
            }
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $columns = [];
            foreach (['arterial', 'side_street'] as $scope) {
                foreach (['pre_outage', 'during_outage', 'post_recovery'] as $segment) {
                    $columns[] = "avg_wait_time_{$segment}_{$scope}";
                    $columns[] = "throughput_per_min_{$segment}_{$scope}";
                }
            }
            $table->dropColumn($columns);
        });
    }
};
