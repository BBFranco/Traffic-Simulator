<?php

namespace App\View\Components;

use Illuminate\View\Component;
use Illuminate\View\View;

class ResponsiveNavLink extends Component
{
    public string $classes;

    public function __construct(public bool $active = false)
    {
        $base = 'block w-full ps-3 pe-4 py-2 border-l-4 text-start text-base font-medium transition duration-150 ease-in-out focus:outline-none';

        $this->classes = $active
            ? $base.' border-sky-600 bg-sky-50 text-sky-800 dark:border-sky-400 dark:bg-sky-500/10 dark:text-sky-200'
            : $base.' border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-800 hover:border-slate-300 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200 dark:hover:border-slate-600';
    }

    public function render(): View
    {
        return view('components.responsive-nav-link');
    }
}
