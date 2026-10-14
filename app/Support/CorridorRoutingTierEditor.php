<?php

namespace App\Support;

use App\Enums\BlockTier;
use App\Exceptions\CorridorRoutingException;
use Illuminate\Support\Collection;
use stdClass;

/**
 * Applies the Road Editor's Destinations edits to a corridor config's `routing`
 * section: blocks removed, tiers changed (the block stops being provisional),
 * and new blocks added between two points (an intersection id, or
 * `<road id>:start|end`). Everything is checked first - a
 * CorridorRoutingException for the first edit that doesn't fit, before
 * anything is changed.
 */
class CorridorRoutingTierEditor
{
    /**
     * @param  array<int, array{id: string, tier: int|float|string}>  $tiers
     * @param  array<int, array{id: string, from: string, to: string, tier: int|float|string}>  $added
     * @param  array<int, string>  $removed
     */
    public function apply(stdClass $config, array $tiers, array $added = [], array $removed = []): void
    {
        $routing = $config->routing ?? throw new CorridorRoutingException('This layout has no routing section to edit.');
        $blocks = collect($routing->blocks ?? [])->keyBy('id');

        $this->ensureKnown($blocks, collect($removed));
        $remaining = $blocks->except($removed);
        $this->ensureKnown($remaining, collect($tiers)->pluck('id'));
        $this->ensureAddable($config, $blocks, collect($added));

        $remaining->each(function (stdClass $block) use ($tiers): void {
            $edit = collect($tiers)->firstWhere('id', $block->id);
            if ($edit === null) {
                return;
            }
            $block->tier = BlockTier::fromNumber($edit['tier'])->number();
            unset($block->provisional);
        });

        $routing->blocks = $remaining
            ->values()
            ->concat(collect($added)->map(fn (array $block) => (object) [
                'id' => $block['id'],
                'from' => $block['from'],
                'to' => $block['to'],
                'tier' => BlockTier::fromNumber($block['tier'])->number(),
            ]))
            ->all();
    }

    /** @param  Collection<int, string>  $ids */
    private function ensureKnown(Collection $blocks, Collection $ids): void
    {
        $unknown = $ids->reject(fn (string $id) => $blocks->has($id));
        if ($unknown->isNotEmpty()) {
            throw new CorridorRoutingException("No routing block [{$unknown->first()}] in this layout.");
        }
    }

    /** @param  Collection<int, array{id: string, from: string, to: string, tier: int|float|string}>  $added */
    private function ensureAddable(stdClass $config, Collection $blocks, Collection $added): void
    {
        $points = $this->points($config);
        $added->each(function (array $block) use ($blocks, $points): void {
            if ($blocks->has($block['id'])) {
                throw new CorridorRoutingException("A routing block [{$block['id']}] already exists.");
            }
            $unknown = collect([$block['from'], $block['to']])->reject(fn (string $point) => $points->contains($point));
            if ($unknown->isNotEmpty()) {
                throw new CorridorRoutingException("[{$block['id']}]: [{$unknown->first()}] is not an intersection or road end in this layout.");
            }
            if ($block['from'] === $block['to']) {
                throw new CorridorRoutingException("[{$block['id']}]: from and to are the same point.");
            }
        });
    }

    /**
     * Every point a block may start or end at: the intersections, and each road's two ends.
     *
     * @return Collection<int, string>
     */
    private function points(stdClass $config): Collection
    {
        $roads = collect($config->arterials ?? [])->concat($config->connectors ?? []);

        return collect($config->arterials ?? [])
            ->flatMap(fn (stdClass $arterial) => collect($arterial->intersections ?? [])->pluck('id'))
            ->concat($roads->flatMap(fn (stdClass $road) => ["{$road->id}:start", "{$road->id}:end"]));
    }
}
