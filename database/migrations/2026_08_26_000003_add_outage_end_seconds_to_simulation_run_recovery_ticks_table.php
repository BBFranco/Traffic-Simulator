<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The power model used to have no restoration event - a triggered outage ran
 * to the end of the batch run (see runHeadless.js's prior buildSummary()),
 * so the recovery chart's shaded band always covered "trigger to end of
 * series". Power now actually comes back on at `power_outage_end_seconds`
 * (see runBatch.mjs/results.js's outage schedule), so the chart needs the
 * real end of the band instead of assuming it's the last sample.
 * `power_event_seconds` (existing column) keeps meaning "outage start".
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
            $table->float('power_outage_end_seconds')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
            $table->dropColumn('power_outage_end_seconds');
        });
    }
};
