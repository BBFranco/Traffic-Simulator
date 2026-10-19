<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A rolling blackout's two stages (zones 1+3 dark, then zone 2), splitting the during-outage segment, per scope - null
 * on every other run. `zone_stats` holds each zone's figures, segments and recovery (runHeadless.js's zoneSummary()) for
 * every power state, as JSON like road_waits rather than ~60 more columns. Null for runs from before zones.
 */
return new class extends Migration
{
    private const STAGES = ['stage1', 'stage2'];

    private const SCOPE_SUFFIXES = ['', '_arterial', '_side_street'];

    public function up(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            foreach ($this->stageColumns() as $column) {
                $table->float($column)->nullable();
            }
            $table->json('zone_stats')->nullable()->after('road_waits');
        });
    }

    public function down(): void
    {
        Schema::table('simulation_runs', function (Blueprint $table) {
            $table->dropColumn([...$this->stageColumns(), 'zone_stats']);
        });
    }

    /** @return array<int, string> */
    private function stageColumns(): array
    {
        return collect(self::SCOPE_SUFFIXES)
            ->crossJoin(self::STAGES)
            ->flatMap(fn (array $parts): array => ["avg_wait_time_{$parts[1]}{$parts[0]}", "throughput_per_min_{$parts[1]}{$parts[0]}"])
            ->all();
    }
};
