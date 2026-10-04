<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Which routing mode a run used (App\Enums\RoutingMode) - every earlier row was random turning.
 * Recovery-tick series carry it too, so a destination batch doesn't overwrite the random one's curves.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->string('routing_mode', 16)->default('random')->after('controller_mode');
        });
        Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
            $table->string('routing_mode', 16)->default('random')->after('corridor_config');
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn('routing_mode');
        });
        Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
            $table->dropColumn('routing_mode');
        });
    }
};
