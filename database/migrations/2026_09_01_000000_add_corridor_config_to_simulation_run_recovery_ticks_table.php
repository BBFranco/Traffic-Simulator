<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Recovery ticks had no corridor tag at all, so the "Recovery after a power cut" line
 * charts stayed corridor-blind even after the /results corridor filter started scoping
 * everything else (simulation_runs.corridor_config). Every row on this table so far was
 * produced against the default Hatfield corridor - the only one the batch runner has ever
 * actually been pointed at - so existing rows backfill to that id rather than sitting as
 * unmatched nulls once the filter starts using this column.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('simulation_run_recovery_ticks', 'corridor_config')) {
            Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
                $table->string('corridor_config')->nullable()->after('sensor_mode');
            });
        }

        DB::table('simulation_run_recovery_ticks')
            ->whereNull('corridor_config')
            ->update(['corridor_config' => 'hatfield-pretorius-francisbaard']);

        if (! Schema::hasIndex('simulation_run_recovery_ticks', 'recovery_ticks_corridor_mode_sensor_idx')) {
            Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
                $table->index(['corridor_config', 'controller_mode', 'sensor_mode'], 'recovery_ticks_corridor_mode_sensor_idx');
            });
        }
    }

    public function down(): void
    {
        Schema::table('simulation_run_recovery_ticks', function (Blueprint $table) {
            $table->dropIndex('recovery_ticks_corridor_mode_sensor_idx');
            $table->dropColumn('corridor_config');
        });
    }
};
