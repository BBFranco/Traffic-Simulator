<?php

namespace App\View\Composers;

use Illuminate\View\View;

/**
 * Sensor mode metadata, shared class fragments, and the sim's boot payload -
 * kept out of the Blade file per project convention (no @php blocks in views).
 */
class SimulatorComposer
{
    public function compose(View $view): void
    {
        $data = $view->getData();

        $view->with([
            'sensorModes' => $this->sensorModes(),
            'toneClasses' => $this->toneClasses(),
            'controllerModeOptions' => $this->controllerModeOptions(),
            'speedOptions' => $this->speedOptions(),
            'viewOptions' => $this->viewOptions(),
            'liveKpis' => $this->liveKpis(),
            'livePanels' => $this->livePanels(),
            'liveRoadColumns' => $this->liveRoadColumns(),
            'mapOverlays' => $this->mapOverlays(),
            'inset' => 'rounded-md border border-slate-200 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-950/40',
            'tinyInput' => 'rounded border-slate-300 bg-white py-0.5 text-[10px] text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
            'checkbox' => 'rounded border-slate-300 bg-white text-sky-600 focus:ring-sky-500 dark:border-slate-600 dark:bg-slate-800 dark:text-sky-500',
            'radio' => 'border-slate-300 bg-white text-sky-600 focus:ring-sky-500 dark:border-slate-600 dark:bg-slate-800 dark:text-sky-500',
            'select' => 'w-full rounded-md border-slate-300 bg-white py-1.5 text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
            'pillBase' => $pillBase = 'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium',
            'pillNeutral' => $pillBase.' border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-400',
            'bootPayload' => [
                'corridors' => $data['corridors'] ?? null,
                'defaultCorridorId' => $data['defaultCorridorId'] ?? null,
                'defaultCorridor' => $data['defaultCorridor'] ?? null,
                'corridorUrlTemplate' => route('corridors.show', ['corridor' => '__ID__']),
            ],
        ]);
    }

    /**
     * @return array<string, array{label: string, sees: string, power: string, tone: string}>
     */
    private function sensorModes(): array
    {
        return [
            'none' => ['label' => 'None (timer only)', 'sees' => 'Nothing - fixed-time cycles on a timer.', 'power' => 'n/a', 'tone' => 'slate'],
            'inductive_loop' => ['label' => 'Inductive loop', 'sees' => 'Binary occupancy at the stop line, per approach.', 'power' => 'Low', 'tone' => 'emerald'],
            'radar' => ['label' => 'Radar', 'sees' => 'Approach speed plus rough volume.', 'power' => 'Moderate', 'tone' => 'amber'],
            'camera' => ['label' => 'Camera', 'sees' => 'Precise queue length and vehicle count per approach.', 'power' => 'High', 'tone' => 'rose'],
            'magnetometer' => ['label' => 'Magnetometer', 'sees' => 'Vehicle presence and count only. Cheap.', 'power' => 'Very low', 'tone' => 'emerald'],
        ];
    }

    /**
     * @return array<string, string>
     */
    private function toneClasses(): array
    {
        return [
            'slate' => 'border-slate-300 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400',
            'emerald' => 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-300',
            'amber' => 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300',
            'rose' => 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300',
        ];
    }

    /**
     * 'none' (free flow) isn't a mode a user picks from the panel - it's only ever set by a
     * corridor config (a highway backbone has no signal at all, see corridor.js's mode:"none"
     * support) - included here just so that arterial's mode toggle shows a selected button
     * instead of none highlighted.
     *
     * @return array<string, string>
     */
    private function controllerModeOptions(): array
    {
        return [
            'fixed' => 'Fixed-time',
            'adaptive' => 'Adaptive',
            'green_wave' => 'Green wave',
            'none' => 'Free flow',
        ];
    }

    /**
     * @return array<string, string>
     */
    private function speedOptions(): array
    {
        return ['0.5' => '0.5×', '1' => '1×', '2' => '2×', '4' => '4×', '8' => '8×', '16' => '16×'];
    }

    /**
     * Render-only switch - simulator.js swaps renderers without touching the engine.
     *
     * @return array<string, string>
     */
    private function viewOptions(): array
    {
        return ['2d' => '2D', '3d' => '3D'];
    }

    /**
     * The collapsed live-statistics bar, in order. The last two drop off at narrow widths.
     *
     * @return array<string, array{label: string, unit: string}>
     */
    private function liveKpis(): array
    {
        return [
            'onNetwork' => ['label' => 'On network', 'unit' => 'veh'],
            'throughput' => ['label' => 'Throughput', 'unit' => 'veh/min'],
            'avgWait' => ['label' => 'Avg wait', 'unit' => 's'],
            'stopsPerVeh' => ['label' => 'Stops/veh', 'unit' => ''],
            'zeroStopPct' => ['label' => 'Zero-stop', 'unit' => '%'],
            'stranded' => ['label' => 'Stranded', 'unit' => 'veh'],
        ];
    }

    /**
     * The expanded live-statistics panels; each row key is a field simulator.js fills.
     *
     * @return array<string, array{title: string, routingOnly: bool, rows: array<string, string>}>
     */
    private function livePanels(): array
    {
        return [
            'flow' => ['title' => 'Flow', 'routingOnly' => false, 'rows' => [
                'onNetwork' => 'On network',
                'completed' => 'Completed',
                'throughputPerMin' => 'Throughput, veh/min',
                'avgSpeedKph' => 'Avg speed, km/h',
            ]],
            'delay' => ['title' => 'Delay', 'routingOnly' => false, 'rows' => [
                'avgWaitRolling' => 'Avg wait, last 60 s',
                'avgWaitRun' => 'Avg wait, run',
                'tripDelayS' => 'Trip delay',
                'stopsPerVeh' => 'Stops/veh',
                'zeroStopPct' => 'Zero-stop',
                'arrivalsOnGreenPct' => 'Arrivals on green',
            ]],
            'health' => ['title' => 'Queues and health', 'routingOnly' => false, 'rows' => [
                'avgQueue' => 'Avg queue, veh',
                'maxQueue' => 'Max queue',
                'spillback' => 'Spillbacks, now / total',
                'blocked' => 'Blocked junctions, now / total',
                'stranded' => 'Stranded',
                'worst' => 'Longest wait',
                'drift' => 'Drift',
            ]],
            'signals' => ['title' => 'Signals', 'routingOnly' => false, 'rows' => [
                'signalsDark' => 'Signals dark',
                'outage' => 'Power',
                'recoveryPct' => 'Throughput vs pre-cut',
                'replayDelta' => 'Vs fixed-time, same seed',
            ]],
            'routing' => ['title' => 'Routing', 'routingOnly' => true, 'rows' => [
                'divertedPct' => 'Diverted',
                'missedDrivewaysPct' => 'Missed driveways',
                'missedTurns' => 'Missed turns',
                'lostArrivals' => 'Lost arrivals',
                'drivewayWaitS' => 'Driveway wait',
                'carsInDriveways' => 'Cars in driveways',
            ]],
        ];
    }

    /**
     * @return array<string, string>
     */
    private function liveRoadColumns(): array
    {
        return [
            'name' => 'Road',
            'onRoad' => 'Cars',
            'avgWaitNow' => 'Wait now',
            'clearedPerMin' => 'Cleared/min',
            'zeroStopPct' => 'Zero-stop',
            'queue' => 'Queue',
        ];
    }

    /**
     * Live-statistics overlays in the map's Layers box - off until ticked. The ramps match
     * renderer.js's OVERLAY_RAMPS: one hue, opacity carrying the magnitude.
     *
     * @return array<string, array{label: string, legend: string, ramp: string}>
     */
    private function mapOverlays(): array
    {
        return [
            'showQueueHeatmap' => ['label' => 'Queue heatmap', 'legend' => '0 to 20+ veh', 'ramp' => 'from-rose-600/20 to-rose-600/85'],
            'showDensity' => ['label' => 'Density', 'legend' => '0 to 120+ veh/lane-km', 'ramp' => 'from-violet-600/20 to-violet-600/85'],
        ];
    }
}
