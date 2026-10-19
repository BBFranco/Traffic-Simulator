<?php

namespace App\Support;

use App\Exceptions\CorridorLaneUseException;
use Illuminate\Support\Collection;
use stdClass;

/**
 * Replaces a corridor config's slip lanes (the `slip_` connectors, the joins that tie them to their roads, and the
 * nodes' `slipLanes`) with the set the Road Editor drew. Checked against the config first - every node exists, every
 * connector is one of the listed slip lanes', every join has a slip connector at one end and a known road at the
 * other - a CorridorLaneUseException for the first that doesn't fit, before anything changes.
 */
class CorridorSlipLaneEditor
{
    private const SLIP_PREFIX = 'slip_';

    /**
     * @param  array<int, array{nodeId: string, direction: string, backM: int|float}>  $slipLanes
     * @param  array<int, array<string, mixed>>  $connectors
     * @param  array<int, array{from: string, to: string, fromAtM?: int|float, toAtM?: int|float, slip?: bool}>  $joins
     */
    public function apply(stdClass $config, array $slipLanes, array $connectors, array $joins): void
    {
        $nodes = $this->arterialNodes($config);
        $slipLanes = collect($slipLanes);

        $slipLanes->each(fn (array $slipLane) => $nodes->has($slipLane['nodeId'])
            ?: throw new CorridorLaneUseException("No arterial intersection [{$slipLane['nodeId']}] for a slip lane."));

        $expectedIds = $slipLanes->map(fn (array $slipLane) => self::SLIP_PREFIX."{$slipLane['nodeId']}_{$slipLane['direction']}");
        $connectorIds = collect($connectors)->pluck('id');
        if ($expectedIds->sort()->values()->all() !== $connectorIds->sort()->values()->all()) {
            throw new CorridorLaneUseException('The slip roads sent don\'t match the slip lanes listed.');
        }

        $roadIds = collect($config->arterials ?? [])->pluck('id')
            ->merge(collect($config->connectors ?? [])->pluck('id')->reject(fn (string $id) => $this->isSlipId($id)))
            ->merge($connectorIds);
        collect($joins)->each(fn (array $join) => $this->ensureJoinFits($join, $roadIds));

        $this->removeSlipLanes($config, $nodes);

        $config->connectors = [...($config->connectors ?? []), ...collect($connectors)->map(fn (array $connector) => $this->toObject($connector))->all()];
        $config->joins = [...($config->joins ?? []), ...collect($joins)->map(fn (array $join) => $this->toObject($join))->all()];
        $slipLanes->groupBy('nodeId')->each(function (Collection $entries, string $nodeId) use ($nodes) {
            $nodes->get($nodeId)->slipLanes = $entries
                ->map(fn (array $slipLane) => (object) ['direction' => $slipLane['direction'], 'backM' => $slipLane['backM']])
                ->values()
                ->all();
        });
    }

    /** @return Collection<string, stdClass> */
    private function arterialNodes(stdClass $config): Collection
    {
        return collect($config->arterials ?? [])
            ->flatMap(fn (stdClass $arterial) => $arterial->intersections ?? [])
            ->keyBy('id');
    }

    /** @param  Collection<string, stdClass>  $nodes */
    private function removeSlipLanes(stdClass $config, Collection $nodes): void
    {
        $config->connectors = collect($config->connectors ?? [])
            ->reject(fn (stdClass $connector) => $this->isSlipId($connector->id))
            ->values()
            ->all();
        $config->joins = collect($config->joins ?? [])
            ->reject(fn (stdClass $join) => $this->isSlipRef($join->from) || $this->isSlipRef($join->to))
            ->values()
            ->all();
        $nodes->each(function (stdClass $node) {
            unset($node->slipLanes);
        });
    }

    /**
     * @param  array{from: string, to: string}  $join
     * @param  Collection<int, string>  $roadIds
     */
    private function ensureJoinFits(array $join, Collection $roadIds): void
    {
        $label = "{$join['from']} -> {$join['to']}";

        if (! $this->isSlipRef($join['from']) && ! $this->isSlipRef($join['to'])) {
            throw new CorridorLaneUseException("Join [{$label}] has no slip road at either end.");
        }

        collect([$join['from'], $join['to']])
            ->map(fn (string $ref) => strtok($ref, ':'))
            ->reject(fn (string $roadId) => $roadIds->contains($roadId))
            ->each(fn (string $roadId) => throw new CorridorLaneUseException("Join [{$label}] names an unknown road [{$roadId}]."));
    }

    private function isSlipId(string $id): bool
    {
        return str_starts_with($id, self::SLIP_PREFIX);
    }

    private function isSlipRef(string $ref): bool
    {
        return $this->isSlipId(strtok($ref, ':'));
    }

    /** @param  array<string, mixed>  $value */
    private function toObject(array $value): stdClass
    {
        return json_decode(json_encode($value, JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR), false, 512, JSON_THROW_ON_ERROR);
    }
}
