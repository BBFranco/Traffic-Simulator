<button {{ $attributes->merge(['type' => 'submit', 'class' => 'inline-flex items-center justify-center rounded-md border border-transparent bg-sky-600 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-white transition ease-in-out duration-150 hover:bg-sky-500 focus:bg-sky-500 active:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:ring-offset-white disabled:opacity-40 dark:bg-sky-500 dark:text-slate-950 dark:hover:bg-sky-400 dark:focus:bg-sky-400 dark:active:bg-sky-600 dark:focus:ring-offset-slate-900']) }}>
    {{ $slot }}
</button>
