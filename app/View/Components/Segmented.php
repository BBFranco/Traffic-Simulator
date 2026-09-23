<?php

namespace App\View\Components;

use Illuminate\View\Component;
use Illuminate\View\View;

class Segmented extends Component
{
    public string $padClasses;

    public function __construct(
        public string $control,
        public array $options,
        public ?string $value = null,
        string $size = 'md',
    ) {
        $this->padClasses = $size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs';
    }

    public function render(): View
    {
        return view('components.segmented');
    }
}
