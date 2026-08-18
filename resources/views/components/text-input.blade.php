@props(['disabled' => false])

<input @disabled($disabled) {{ $attributes->merge(['class' => 'rounded-md border-slate-300 bg-white text-slate-900 placeholder-slate-400 shadow-sm focus:border-sky-500 focus:ring-sky-500 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500']) }}>
