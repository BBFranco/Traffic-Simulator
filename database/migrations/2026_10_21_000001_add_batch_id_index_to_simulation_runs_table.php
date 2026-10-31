<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The Results page reads a batch's runs by `batch_id` alone, which the (corridor_config, batch_id) index can't seek on -
 * every read scanned the whole table, JSON columns included.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->index('batch_id', 'simulation_runs_batch_id_index');
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropIndex('simulation_runs_batch_id_index');
        });
    }
};
