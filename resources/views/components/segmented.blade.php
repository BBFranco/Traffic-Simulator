{{--
    Segmented radio control. Active state is driven purely by a `data-active`
    attribute that the page script flips, so there is no class juggling in JS - and
    because the classes live only here, the light/dark styling cannot drift between
    the Blade-rendered controls and the ones the simulator clones at runtime.
--}}
<div class="inline-flex w-full rounded-md border border-slate-300 bg-slate-100 p-0.5 dark:border-slate-700 dark:bg-slate-800/80"
     role="group" data-segmented="{{ $control }}">
    @foreach ($options as $optionValue => $label)
        <button type="button"
                data-control="{{ $control }}"
                data-value="{{ $optionValue }}"
                data-active="{{ $optionValue === $value ? 'true' : 'false' }}"
                aria-pressed="{{ $optionValue === $value ? 'true' : 'false' }}"
                class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded font-medium transition {{ $padClasses }}
                       text-slate-500 hover:text-slate-900
                       data-[active=true]:bg-sky-600 data-[active=true]:text-white data-[active=true]:shadow-sm
                       dark:text-slate-400 dark:hover:text-slate-200
                       dark:data-[active=true]:bg-sky-500 dark:data-[active=true]:text-slate-950
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500">
            {{ $label }}
        </button>
    @endforeach
</div>
