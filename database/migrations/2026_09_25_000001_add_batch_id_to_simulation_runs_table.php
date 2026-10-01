<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

/**
 * Tags every run with the batch (one "Generate dataset" click / one runBatch.mjs invocation)
 * that produced it, so /results can show only each corridor's latest batch instead of pooling
 * runs from older engine versions.
 *
 * Legacy rows are backfilled per corridor by splitting on idle gaps: runs inside a batch are
 * posted every 25 runs (a few minutes apart at most), while separate batches sit at least
 * half an hour apart in every dataset so far - checked to yield clean 360-run batches.
 */
return new class extends Migration
{
    private const BATCH_GAP_SECONDS = 1200;

    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->uuid('batch_id')->nullable()->after('id');
            $table->index(['corridor_config', 'batch_id']);
        });

        DB::table('simulation_runs')
            ->orderBy('id')
            ->get(['id', 'corridor_config', 'created_at'])
            ->groupBy('corridor_config')
            ->each(function ($runs) {
                $previousAt = null;
                $batchId = null;

                foreach ($runs as $run) {
                    $createdAt = Carbon::parse($run->created_at);
                    $isNewBatch = $previousAt === null || $previousAt->diffInSeconds($createdAt, true) > self::BATCH_GAP_SECONDS;
                    $batchId = $isNewBatch ? (string) Str::uuid() : $batchId;
                    $previousAt = $createdAt;

                    DB::table('simulation_runs')->where('id', $run->id)->update(['batch_id' => $batchId]);
                }
            });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropIndex(['corridor_config', 'batch_id']);
            $table->dropColumn('batch_id');
        });
    }
};
