<?php

namespace App\Observers;

use App\Models\User;
use App\Support\UserCorridorLayouts;

/** Every new account starts with its own copy of the standard Hatfield layout, to see how the system works. */
class UserObserver
{
    public function __construct(private readonly UserCorridorLayouts $layouts) {}

    public function created(User $user): void
    {
        $this->layouts->provisionDefault($user);
    }
}
