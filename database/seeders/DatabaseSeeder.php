<?php

namespace Database\Seeders;

use App\Models\User;
use Illuminate\Database\Console\Seeds\WithoutModelEvents;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class DatabaseSeeder extends Seeder
{
    use WithoutModelEvents;

    /**
     * A single local account so `/simulator` is reachable straight after
     * `migrate --seed`. Registration is open too - this is only a shortcut.
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
