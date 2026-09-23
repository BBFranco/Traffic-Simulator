<?php

namespace App\View\Components;

use Illuminate\View\Component;
use Illuminate\View\View;

class Modal extends Component
{
    public string $maxWidthClass;

    public function __construct(public string $name, public bool $show = false, string $maxWidth = '2xl')
    {
        $this->maxWidthClass = match ($maxWidth) {
            'sm' => 'sm:max-w-sm',
            'md' => 'sm:max-w-md',
            'lg' => 'sm:max-w-lg',
            'xl' => 'sm:max-w-xl',
            default => 'sm:max-w-2xl',
        };
    }

    public function render(): View
    {
        return view('components.modal');
    }
}
