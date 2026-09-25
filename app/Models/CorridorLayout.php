<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One user's road layout - a corridor config (same shape as `corridors/*.json`)
 * plus the config as it was imported, which "Revert to original" puts back.
 * See UserCorridorLayouts for everything that reads or edits these.
 */
#[Fillable(['slug', 'name', 'config', 'original_config'])]
class CorridorLayout extends Model
{
    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        // Objects, not arrays, so an empty `{}` in a config stays an object when it's encoded again.
        return [
            'config' => 'object',
            'original_config' => 'object',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** True once the layout has been edited since it was imported. */
    public function hasEdits(): bool
    {
        return $this->config != $this->original_config;
    }
}
