<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Destination routing's per-run metrics (runHeadless.js's routingSummary()) - all null on a
 * random-turning run. `routing_stats` keeps the breakdowns: pull-offs per block and driveway,
 * missed turns and driveways by cause, and where missed driveways went instead.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->unsignedInteger('trips')->nullable()->after('max_wait_time');
            $table->double('mean_trip_time')->nullable()->after('trips');
            $table->double('mean_trip_delay')->nullable()->after('mean_trip_time');
            $table->unsignedInteger('pulled_off')->nullable()->after('mean_trip_delay');
            $table->unsignedInteger('missed_turns')->nullable()->after('pulled_off');
            $table->unsignedInteger('missed_driveways')->nullable()->after('missed_turns');
            $table->double('diversion_pct')->nullable()->after('missed_driveways');
            $table->json('routing_stats')->nullable()->after('diversion_pct');
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn(['trips', 'mean_trip_time', 'mean_trip_delay', 'pulled_off', 'missed_turns', 'missed_driveways', 'diversion_pct', 'routing_stats']);
        });
    }
};
