<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * One row per uploaded traffic-count video (Traffic Counter spec §3). Unlike
 * `simulation_runs` (an immutable summary written once), a row here starts
 * `pending` and is mutated in place by ProcessTrafficCount as the queued job
 * progresses - so this table keeps normal `updated_at` tracking rather than
 * the create-only `created_at`-only pattern the batch-run tables use.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('traffic_counts', function (Blueprint $table) {
            $table->id();
            $table->string('corridor_config');
            $table->string('street');
            $table->string('label')->nullable();
            $table->string('video_path')->nullable();
            $table->string('annotated_video_path')->nullable();
            $table->json('line_coords_json');
            $table->enum('status', ['pending', 'processing', 'done', 'failed'])->default('pending');
            // text, not string: a Python traceback or a subprocess's captured stdout/stderr
            // (see ProcessTrafficCount's failure path) easily exceeds varchar(255) - a real
            // truncation error on this exact column masked the actual failure once already.
            $table->text('error_message')->nullable();
            $table->integer('observation_duration_seconds')->nullable();
            $table->integer('frames_processed')->nullable();
            // Distinct tracks the tracker created, including any that never crossed the line.
            $table->integer('vehicles_detected')->nullable();
            // Tracks that crossed the counting line - drives every flow stat below.
            $table->integer('total_vehicles')->nullable();
            $table->integer('cars_count')->nullable();
            $table->integer('trucks_count')->nullable();
            $table->integer('unclassified_count')->nullable();
            $table->float('mean_flow')->nullable();
            $table->float('min_flow')->nullable();
            $table->float('max_flow')->nullable();
            $table->float('std_dev')->nullable();
            $table->float('peak_5min_flow')->nullable();
            // Least-squares sinusoid fit, veh/lane/min - see §6 of the spec.
            $table->float('fitted_mid')->nullable();
            $table->float('fitted_amplitude')->nullable();
            $table->float('fitted_r_squared')->nullable();
            // Fixed input to the fit (taken from the corridor config), never itself calibrated.
            $table->integer('assumed_period_seconds')->nullable();
            $table->timestamps();

            $table->index(['corridor_config', 'street', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('traffic_counts');
    }
};
