<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * App\Enums\BatchKind - every earlier batch was a main one. A sensitivity batch never becomes
 * the batch Results shows; it only feeds the report's appendix.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->string('batch_kind', 16)->default('main')->after('batch_id');
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn('batch_kind');
        });
    }
};
