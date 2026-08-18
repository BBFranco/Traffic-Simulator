<?php

namespace App\View\Components;

use Illuminate\View\Component;
use Illuminate\View\View;

class AppLayout extends Component
{
    /**
     * @param  string|null  $title  Appended to the app name in the browser title bar.
     * @param  bool  $wide  Use the full viewport width instead of the centred column.
     * @param  bool  $flush  Drop the page padding entirely (used by the simulator canvas).
     */
    public function __construct(
        public ?string $title = null,
        public bool $wide = false,
        public bool $flush = false,
    ) {}

    /**
     * Get the view / contents that represents the component.
     */
    public function render(): View
    {
        return view('layouts.app');
    }
}
