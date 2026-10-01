<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Each user's own road layouts - the Road Editor imports and edits these, the
 * Simulator runs them. `config` is the corridor JSON (same shape as
 * `corridors/*.json`); `original_config` is the layout as it was imported,
 * which the editor's "Revert to original" puts back. `slug` is the layout's
 * id in URLs and in the config's own `id`, unique per user.
 *
 * Existing users each get a copy of the standard Hatfield layout, the same one
 * a new account gets (UserObserver).
 */
return new class extends Migration
{
    private const DEFAULT_TEMPLATE = 'hatfield-pretorius-francisbaard';

    public function up(): void
    {
        Schema::create('corridor_layouts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('slug');
            $table->string('name');
            $table->json('config');
            $table->json('original_config');
            $table->timestamps();

            $table->unique(['user_id', 'slug']);
        });

        $template = base_path('corridors/'.self::DEFAULT_TEMPLATE.'.json');
        if (! file_exists($template)) {
            return;
        }

        // Decoded as objects so an empty `{}` stays an object.
        $config = json_decode((string) file_get_contents($template), false, 512, JSON_THROW_ON_ERROR);
        $config->id = self::DEFAULT_TEMPLATE;
        $json = json_encode($config, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);

        DB::table('users')->orderBy('id')->pluck('id')->each(fn (int $userId) => DB::table('corridor_layouts')->insert([
            'user_id' => $userId,
            'slug' => self::DEFAULT_TEMPLATE,
            'name' => $config->name ?? self::DEFAULT_TEMPLATE,
            'config' => $json,
            'original_config' => $json,
            'created_at' => now(),
            'updated_at' => now(),
        ]));
    }

    public function down(): void
    {
        Schema::dropIfExists('corridor_layouts');
    }
};
