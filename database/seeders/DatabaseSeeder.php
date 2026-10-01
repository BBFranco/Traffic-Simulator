<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class DatabaseSeeder extends Seeder
{
    /**
     * A single local account so `/simulator` is reachable straight after
     * `migrate --seed`. Registration is open too - this is only a shortcut.
     * Model events stay on, so it gets the standard layout like any new account (UserObserver).
     */
    public function run(): void
    {
        User::query()->firstOrCreate(
            ['email' => 'demo@traffic-simulator.test'],
            [
                'name' => 'Demo',
                'password' => Hash::make('password'),
                'email_verified_at' => now(),
            ],
        );
    }
}
