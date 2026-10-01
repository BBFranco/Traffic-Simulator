<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * When the batch a run belongs to was started (before its warm-up probe), so /results can show
 * how long a whole batch took - a run's own created_at only says when its POST landed. Null for
 * legacy rows.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->timestamp('batch_started_at')->nullable()->after('batch_id');
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn('batch_started_at');
        });
    }
};
