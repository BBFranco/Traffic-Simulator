{{--
    /traffic-counter (Traffic Counter spec) - third tab, right of Results. Upload a
    real traffic video, draw a counting line over its first frame, and let a queued
    job (ProcessTrafficCount) run YOLOv8 detection/tracking/counting + the
    sinusoid demand fit against it. Data hand-off to JS follows the same
    convention as simulator.blade.php/results.blade.php: one `<script
    type="application/json">` boot payload, parsed once by traffic-counter.js.
--}}

@php
    $card = 'rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/60';
    $select = 'w-full rounded-md border-slate-300 bg-white py-1.5 text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';
    $input = 'w-full rounded-md border-slate-300 bg-white py-1.5 text-xs text-slate-900 focus:border-sky-500 focus:ring-sky-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100';
    $label = 'mb-1 block text-[10px] font-semibold uppercase tracking-wider text-slate-500';
    $tableHead = 'bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 dark:bg-slate-950/40';
@endphp

<x-app-layout title="Traffic Counter" wide>
    <x-slot name="header">
        <div>
            <h1 class="text-xl font-semibold leading-tight text-slate-900 dark:text-slate-100">Traffic Counter</h1>
            <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Upload real footage, count vehicles crossing a line, and compare the observed flow against
                this corridor's assumed synthetic demand.
            </p>
        </div>
    </x-slot>

    <div class="grid gap-6 xl:grid-cols-[380px_1fr]">
        {{-- ============================================================ upload --}}
        <section class="{{ $card }} p-4">
            <h2 class="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">New count</h2>

            <form id="upload-form" class="space-y-3">
                <div>
                    <label for="field-video" class="{{ $label }}">Video file</label>
                    <input id="field-video" type="file" accept="video/*" required class="{{ $input }}" />
                </div>

                <div>
                    <label for="field-corridor" class="{{ $label }}">Corridor</label>
                    <select id="field-corridor" class="{{ $select }}">
                        @foreach ($corridors as $corridor)
                            <option value="{{ $corridor['id'] }}" {{ $corridor['id'] === $defaultCorridorId ? 'selected' : '' }}>{{ $corridor['name'] }}</option>
                        @endforeach
                    </select>
                </div>

                <div>
                    <label for="field-street" class="{{ $label }}">Street</label>
                    <select id="field-street" class="{{ $select }}"></select>
                </div>

                <div>
                    <label for="field-label" class="{{ $label }}">Label (optional)</label>
                    <input id="field-label" type="text" placeholder="e.g. Francis Baard, morning peak" class="{{ $input }}" />
                </div>

                <div class="rounded-md border border-slate-200 p-3 text-[11px] text-slate-500 dark:border-slate-700">
                    <p class="mb-2">Click two points on the frame below to draw the counting line, in the direction traffic crosses it.</p>
                    <div class="relative w-full overflow-hidden rounded border border-slate-300 bg-slate-100 dark:border-slate-700 dark:bg-slate-950">
                        {{-- `display:none` (Tailwind's `hidden`) stops some browsers from ever
                             decoding frames into a <video>, so `canvas.drawImage()` reads back
                             blank. A fully zero-sized box risks the same treatment in some
                             engines, so this stays a real (if invisible) 1x1px box instead -
                             absolutely positioned so it never affects layout. --}}
                        <video id="frame-source" class="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"></video>
                        <canvas id="line-canvas" class="block w-full cursor-crosshair"></canvas>
                        <p id="line-canvas-hint" class="p-6 text-center text-slate-400">Choose a video file to draw the line</p>
                    </div>
                    <button type="button" id="clear-line-button" class="mt-2 text-[11px] font-semibold text-sky-700 hover:underline dark:text-sky-400">
                        Clear line
                    </button>
                </div>

                <label class="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                    <input id="field-save-annotated" type="checkbox" checked class="rounded border-slate-300 text-sky-600 focus:ring-sky-500 dark:border-slate-600" />
                    Save annotated QA video (boxes, IDs, counting line)
                </label>

                <button type="submit" id="upload-submit"
                        class="w-full rounded-md bg-sky-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400">
                    Upload &amp; process
                </button>
                <p id="upload-error" class="hidden text-[11px] text-red-600 dark:text-red-400"></p>
            </form>

            <div class="mt-6">
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Recent counts</h3>
                <ul id="recent-counts-list" class="space-y-1 text-xs">
                    @forelse ($recentCounts as $count)
                        <li>
                            <button type="button" data-count-id="{{ $count->id }}"
                                    class="recent-count-row flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60">
                                <span class="truncate">{{ $count->label ?? ('Count #'.$count->id) }}</span>
                                <span class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase
                                    {{ match($count->status) {
                                        'done' => 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
                                        'failed' => 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300',
                                        default => 'bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
                                    } }}">{{ $count->status }}</span>
                            </button>
                        </li>
                    @empty
                        <li class="text-slate-400">No counts uploaded yet.</li>
                    @endforelse
                </ul>
            </div>
        </section>

        {{-- ============================================================ results --}}
        <section class="space-y-6">
            <div id="processing-status" class="hidden {{ $card }} p-4 text-xs text-slate-600 dark:text-slate-300">
                <div class="flex items-center gap-2.5">
                    <x-traffic-loader class="h-4 w-11" />
                    <span id="processing-status-label">Processing...</span>
                </div>
            </div>

            <div id="results-empty" class="{{ $card }} p-8 text-center text-xs text-slate-400">
                Upload a video, or pick a finished count from the list, to see its flow stats here.
            </div>

            <div id="results-panel" class="hidden space-y-6">
                {{-- detection quality --}}
                <div class="{{ $card }} p-4">
                    <h2 class="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">Detection quality</h2>
                    <dl id="quality-grid" class="grid grid-cols-2 gap-3 sm:grid-cols-4"></dl>
                </div>

                {{-- stats + chart --}}
                <div class="grid gap-4 xl:grid-cols-[1fr_260px]">
                    <figure class="min-w-0 {{ $card }} p-4">
                        <figcaption class="mb-1">
                            <span class="block text-[13px] font-semibold text-slate-900 dark:text-slate-100">Volume over time</span>
                            <span class="text-[10px] text-slate-500">veh/lane/min · observed bars, corridor's assumed demand (dotted), fitted sinusoid (solid)</span>
                        </figcaption>
                        <div class="relative h-[300px] w-full">
                            <canvas id="chart-volume"></canvas>
                        </div>
                    </figure>

                    <div class="{{ $card }} p-4 text-xs">
                        <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Fit summary</h3>
                        <dl id="fit-summary-grid" class="space-y-1.5"></dl>
                    </div>
                </div>

                {{-- annotated video --}}
                <div id="annotated-video-wrap" class="hidden {{ $card }} p-4">
                    <h2 class="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">Annotated QA video</h2>
                    <video id="annotated-video" controls class="w-full rounded-md"></video>
                </div>
            </div>
        </section>
    </div>

    @php
        $bootPayload = [
            'corridors' => $corridors,
            'defaultCorridorId' => $defaultCorridorId,
            'corridorUrlTemplate' => route('corridors.show', ['corridor' => '__ID__']),
            'storeUrl' => route('traffic-counts.store'),
            'statusUrlTemplate' => route('traffic-counts.status', ['trafficCount' => '__ID__']),
            'dataUrlTemplate' => route('traffic-counts.data', ['trafficCount' => '__ID__']),
            'videoUrlTemplate' => route('traffic-counts.video', ['trafficCount' => '__ID__']),
        ];
    @endphp
    <script type="application/json" id="traffic-counter-data">@json($bootPayload)</script>

    @vite('resources/js/traffic-counter.js')
</x-app-layout>
