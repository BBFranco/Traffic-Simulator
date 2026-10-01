<?php

namespace App\View\Components;

use Illuminate\View\Component;
use Illuminate\View\View;

class InfoTip extends Component
{
    public function __construct(
        public string $text = '',
    ) {}

    public function render(): View
    {
        return view('components.info-tip');
    }
}
