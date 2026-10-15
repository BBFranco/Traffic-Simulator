<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * P95 and max wait per scope (main arterial / side streets) alongside the total-scope ones.
 * Every earlier row stays null - those runs never recorded them.
 */
return new class extends Migration
{
    private const COLUMNS = ['p95_wait_time_arterial', 'max_wait_time_arterial', 'p95_wait_time_side_street', 'max_wait_time_side_street'];

    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            foreach (self::COLUMNS as $column) {
                $table->float($column)->nullable()->after('max_wait_time');
            }
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn(self::COLUMNS);
        });
    }
};
