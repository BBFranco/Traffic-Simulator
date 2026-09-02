<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One row per bucketed time window of a `traffic_counts` video (Traffic
 * Counter spec §3) - mirrors the `simulation_runs` / `simulation_run_recovery_ticks`
 * split already used elsewhere: one summary row, one child table for its series.
 * Written once by ProcessTrafficCount when the parent flips to `done`, never
 * updated afterwards, so no `updated_at` to maintain.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('traffic_count_buckets', function (Blueprint $table) {
            $table->id();
            $table->foreignId('traffic_count_id')->constrained()->cascadeOnDelete();
            $table->integer('bucket_start_seconds');
            $table->float('vehicles_per_min');
            $table->integer('cars');
            $table->integer('trucks');
            $table->timestamp('created_at')->useCurrent();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('traffic_count_buckets');
    }
};
