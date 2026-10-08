<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * `warmup_drifting`: the batch's warm-up probe controllers that never levelled off, with each scope's drift (%), so a
 * "not stationary" batch names its culprit. `diagnostics`: demand lost at full map-edge entries and roundabout overruns
 * over the measured window (runHeadless.js's measuredDiagnostics()). Both null on runs from before they existed.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->json('warmup_drifting')->nullable()->after('warmup_stationary');
            $table->json('diagnostics')->nullable()->after('routing_stats');
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn(['warmup_drifting', 'diagnostics']);
        });
    }
};
