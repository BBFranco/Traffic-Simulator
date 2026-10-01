<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The warm-up each run used and whether the batch's probe (sim/warmupProbe.js) found every
 * controller settling to a steady state - null for legacy rows and for a batch run with a
 * hand-picked --warmup-ticks, where nothing was measured.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->unsignedInteger('warmup_ticks')->nullable()->after('corridor_config');
            $table->boolean('warmup_stationary')->nullable()->after('warmup_ticks');
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn(['warmup_ticks', 'warmup_stationary']);
        });
    }
};
