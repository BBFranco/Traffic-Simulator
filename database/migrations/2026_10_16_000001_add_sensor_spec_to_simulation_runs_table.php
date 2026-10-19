<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The sensor configuration a run resolved to (resources/js/sim/sensorSpecs.js): its spec set and a hash of the resolved
 * spec, so a later edit to the field specs never passes for the same configuration. Null for controllers that read no
 * sensors, and for every run from before this was recorded - their configuration can't be established, so they are
 * never back-labelled.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->string('sensor_spec_set', 16)->nullable()->after('sensor_mode');
            $table->string('sensor_spec_hash', 16)->nullable()->after('sensor_spec_set');
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn(['sensor_spec_set', 'sensor_spec_hash']);
        });
    }
};
