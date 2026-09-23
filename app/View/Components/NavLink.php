<?php

namespace App\View\Components;

use Illuminate\View\Component;
use Illuminate\View\View;

class NavLink extends Component
{
    public string $classes;

    public function __construct(public bool $active = false)
    {
        $base = 'inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium leading-5 transition duration-150 ease-in-out focus:outline-none';

        $this->classes = $active
            ? $base.' border-sky-600 text-slate-900 dark:border-sky-400 dark:text-slate-100'
            : $base.' border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:border-slate-600';
    }

    public function render(): View
    {
        return view('components.nav-link');
    }
}
