<?php

namespace App\View\Components;

use Illuminate\View\Component;
use Illuminate\View\View;

class Dropdown extends Component
{
    public string $alignmentClasses;

    public string $widthClass;

    public function __construct(
        string $align = 'right',
        string $width = '48',
        public string $contentClasses = 'py-1 bg-white border border-slate-200 dark:bg-slate-800 dark:border-slate-700',
    ) {
        $this->alignmentClasses = match ($align) {
            'left' => 'ltr:origin-top-left rtl:origin-top-right start-0',
            'top' => 'origin-top',
            default => 'ltr:origin-top-right rtl:origin-top-left end-0',
        };

        $this->widthClass = match ($width) {
            '48' => 'w-48',
            default => $width,
        };
    }

    public function render(): View
    {
        return view('components.dropdown');
    }
}
