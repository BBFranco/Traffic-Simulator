<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * What coordinated adaptive did over a run (controllers/coordinationStats.js): married share per junction, the
 * common cycle per arterial, resync holds, platoon messages, how greens ended. Null for every other mode.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->json('coordination_stats')->nullable()->after('routing_stats');
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn('coordination_stats');
        });
    }
};
