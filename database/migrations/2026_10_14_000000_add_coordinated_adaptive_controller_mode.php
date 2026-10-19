<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * controller_mode becomes a plain string validated against App\Enums\ControllerMode, so
 * coordinated_adaptive (and any later mode) needs no column change.
 */
return new class extends Migration
{
    private const TABLES = ['simulation_runs', 'simulation_run_recovery_ticks'];

    private const LEGACY_MODES = ['fixed', 'adaptive', 'green_wave'];

    public function up(): void
    {
        foreach (self::TABLES as $tableName) {
            Schema::table($tableName, function (Blueprint $table) {
                $table->string('controller_mode', 32)->change();
            });
        }
    }

    public function down(): void
    {
        foreach (self::TABLES as $tableName) {
            Schema::table($tableName, function (Blueprint $table) {
                $table->enum('controller_mode', self::LEGACY_MODES)->change();
            });
        }
    }
};
