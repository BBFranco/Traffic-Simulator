<?php

namespace App\View\Composers;

use Illuminate\View\View;

/**
 * Shared class fragments and the boot payload for traffic-counter.blade.php -
 * kept out of the Blade file per project convention (no @php blocks in views).
 */
class TrafficCounterComposer
{
    public function compose(View $view): void
    {
        $data = $view->getData();

        $view->with([
            'card' => 'rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60',
            'select' => 'w-full rounded-md border-slate-300 bg-white py-1.5 text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
            'input' => 'w-full rounded-md border-slate-300 bg-white py-1.5 text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
            'label' => 'mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500',
            'tableHead' => 'bg-slate-200 text-[10px] uppercase tracking-wider text-slate-600 dark:bg-slate-800 dark:text-slate-300',
            'bootPayload' => [
                'corridors' => $data['corridors'] ?? null,
                'defaultCorridorId' => $data['defaultCorridorId'] ?? null,
                'corridorUrlTemplate' => route('corridor-templates.show', ['corridor' => '__ID__']),
                'storeUrl' => route('traffic-counts.store'),
                'listUrl' => route('traffic-counts.list'),
                'statusUrlTemplate' => route('traffic-counts.status', ['trafficCount' => '__ID__']),
                'dataUrlTemplate' => route('traffic-counts.data', ['trafficCount' => '__ID__']),
                'videoUrlTemplate' => route('traffic-counts.video', ['trafficCount' => '__ID__']),
                'deleteUrlTemplate' => route('traffic-counts.destroy', ['trafficCount' => '__ID__']),
            ],
        ]);
    }
}
