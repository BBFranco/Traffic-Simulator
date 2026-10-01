<?php

namespace App\Support;

use App\Models\CorridorLayout;
use App\Models\User;
use Illuminate\Support\Str;
use RuntimeException;
use stdClass;

/**
 * Each user's own road layouts (CorridorLayout) - what the Road Editor imports
 * and edits and the Simulator runs. Configs are kept as decoded objects so an
 * empty `{}` survives the round trip; the browser sees exactly the corridor
 * JSON shape of `corridors/*.json`, with the layout's slug as its `id`.
 */
class UserCorridorLayouts
{
    /** The template every account starts with - the standard Hatfield grid. */
    public const DEFAULT_TEMPLATE = 'hatfield-pretorius-francisbaard';

    public function __construct(
        private readonly CorridorRepository $templates,
        private readonly CorridorLaneUseEditor $laneUseEditor,
    ) {}

    /**
     * The user's layouts as picker descriptors, standard layout first.
     *
     * @return array<int, array{id: string, name: string, description: string, sortOrder: int, arterials: int, connectors: int, intersections: int, hasEdits: bool}>
     */
    public function index(User $user): array
    {
        return $user->corridorLayouts()
            ->orderBy('id')
            ->get()
            ->map(fn (CorridorLayout $layout) => [
                ...CorridorDescriptor::fromConfig($this->toArray($layout->config), $layout->slug),
                'name' => $layout->name,
                'hasEdits' => $layout->hasEdits(),
            ])
            ->sortBy([['sortOrder', 'asc'], ['name', 'asc']])
            ->values()
            ->all();
    }

    public function defaultSlug(User $user): ?string
    {
        return $this->index($user)[0]['id'] ?? null;
    }

    /** One of the user's own layouts - another user's with the same slug is a 404 too. */
    public function findOrFail(User $user, string $slug): CorridorLayout
    {
        return $user->corridorLayouts()->where('slug', $slug)->firstOrFail();
    }

    /** Gives a (new) user their own copy of the standard Hatfield layout. */
    public function provisionDefault(User $user): void
    {
        $raw = $this->templates->raw(self::DEFAULT_TEMPLATE)
            ?? throw new RuntimeException('The standard layout template corridors/'.self::DEFAULT_TEMPLATE.'.json is missing.');

        $this->store($user, json_decode($raw, false, 512, JSON_THROW_ON_ERROR), self::DEFAULT_TEMPLATE);
    }

    /** A layout from an uploaded corridor JSON, under a slug of its own `id` (or name, or file name) - made unique for this user. */
    public function import(User $user, stdClass $config, string $fileName): CorridorLayout
    {
        $base = Str::slug($config->id ?? $config->name ?? pathinfo($fileName, PATHINFO_FILENAME)) ?: 'layout';
        $config->name ??= pathinfo($fileName, PATHINFO_FILENAME);

        return $this->store($user, $config, $this->uniqueSlug($user, $base));
    }

    /**
     * Applies lane-arrow and turn-lane edits (CorridorLaneUseEditor) - checked in
     * full before anything is stored.
     *
     * @param  array<int, array{nodeId: string, key: string, lanes: array<int, string>, turnLanes?: array<string, array{lengthM: int|float, laneUse: string}>}>  $approaches
     */
    public function updateLaneUse(CorridorLayout $layout, array $approaches): void
    {
        $config = $this->copy($layout->config);
        $this->laneUseEditor->apply($config, $approaches);

        $layout->update(['config' => $config]);
    }

    /** Puts back the layout as it was imported. False if it has no edits. */
    public function revert(CorridorLayout $layout): bool
    {
        if (! $layout->hasEdits()) {
            return false;
        }

        $layout->update(['config' => $this->copy($layout->original_config)]);

        return true;
    }

    /** Deletes a layout - never the user's last one, every page needs one to show. False if it was the last. */
    public function delete(CorridorLayout $layout): bool
    {
        if ($layout->user->corridorLayouts()->count() <= 1) {
            return false;
        }

        $layout->delete();

        return true;
    }

    private function store(User $user, stdClass $config, string $slug): CorridorLayout
    {
        $config->id = $slug;

        return $user->corridorLayouts()->create([
            'slug' => $slug,
            'name' => $config->name ?? $slug,
            'config' => $config,
            'original_config' => $this->copy($config),
        ]);
    }

    private function uniqueSlug(User $user, string $base): string
    {
        $taken = $user->corridorLayouts()->where('slug', 'like', "{$base}%")->pluck('slug');

        $suffix = 1;
        $slug = $base;
        while ($taken->contains($slug)) {
            $suffix += 1;
            $slug = "{$base}-{$suffix}";
        }

        return $slug;
    }

    /** Deep copy of a decoded config, still as objects. */
    private function copy(stdClass $config): stdClass
    {
        return json_decode(json_encode($config, JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR), false, 512, JSON_THROW_ON_ERROR);
    }

    /** @return array<string, mixed> */
    private function toArray(stdClass $config): array
    {
        return json_decode(json_encode($config, JSON_THROW_ON_ERROR), true, 512, JSON_THROW_ON_ERROR);
    }
}
