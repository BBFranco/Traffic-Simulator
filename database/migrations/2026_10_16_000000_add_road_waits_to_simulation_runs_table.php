<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Wait per road over the measured window (engine.js's roadWaits): per road id, the vehicles that used it and their
 * mean and worst wait built up there - the report's per-road table. Null for runs from before this was recorded.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->json('road_waits')->nullable()->after('coordination_stats');
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn('road_waits');
        });
    }
};
