<?php

use App\Enums\PowerState;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * power_state gains rolling_blackout (App\Enums\PowerState). load_shedding keeps its value - it is relabelled
 * "Total blackout", so every existing row stays valid.
 */
return new class extends Migration
{
    private const LEGACY_STATES = ['normal', 'load_shedding'];

    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->enum('power_state', PowerState::values())->change();
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->enum('power_state', self::LEGACY_STATES)->change();
        });
    }
};
