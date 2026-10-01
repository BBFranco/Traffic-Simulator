<?php

namespace App\View\Composers;

use Illuminate\View\View;

/**
 * Shared class fragments and the boot payload for road-editor.blade.php -
 * kept out of the Blade file per project convention (no @php blocks in views).
 */
class RoadEditorComposer
{
    public function compose(View $view): void
    {
        $data = $view->getData();

        $view->with([
            'select' => 'w-full rounded-md border-slate-300 bg-white py-1.5 text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
            'buttonNeutral' => 'rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
            'speedOptions' => ['1' => '1×', '2' => '2×', '4' => '4×', '8' => '8×'],
            'bootPayload' => [
                'corridors' => $data['corridors'] ?? null,
                'defaultCorridorId' => $data['defaultCorridorId'] ?? null,
                'corridorUrlTemplate' => route('corridors.show', ['corridor' => '__ID__']),
                'laneUseUrlTemplate' => route('corridors.lane-use.update', ['corridor' => '__ID__']),
                'importUrl' => route('corridors.store'),
                'deleteUrlTemplate' => route('corridors.destroy', ['corridor' => '__ID__']),
            ],
        ]);
    }
}
