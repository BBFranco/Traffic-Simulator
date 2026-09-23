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
}
