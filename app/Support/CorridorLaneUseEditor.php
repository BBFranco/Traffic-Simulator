<?php

namespace App\Support;

use App\Enums\LaneUseApproach;
use App\Enums\TurnLaneSide;
use App\Exceptions\CorridorLaneUseException;
use stdClass;

/**
 * Applies the Road Editor's lane-arrow and turn-lane edits to a corridor
 * config, decoded as objects so an empty `{}` stays an object when it is
 * encoded again. Every edit is checked against the config (node exists, lane
 * count matches, room for a median-side turn lane) - a CorridorLaneUseException
 * for the first that doesn't fit, before the caller stores anything.
 */
class CorridorLaneUseEditor
{
    /**
     * An approach's `turnLanes`, when given, replace its turn lanes (`[]` removes them).
     *
     * @param  array<int, array{nodeId: string, key: string, lanes: array<int, string>, turnLanes?: array<string, array{lengthM: int|float, laneUse: string}>}>  $approaches
     */
    public function apply(stdClass $config, array $approaches): void
    {
        collect($approaches)->each(fn (array $approach) => $approach['key'] === LaneUseApproach::Arterial->value
            ? $this->applyArterialLaneUse($config, $approach['nodeId'], $approach['lanes'], $approach['turnLanes'] ?? null)
            : $this->applyConnectorLaneUse($config, $approach['nodeId'], $approach['key'], $approach['lanes'], $approach['turnLanes'] ?? null));
    }

    /**
     * @param  array<int, string>  $lanes
     * @param  array<string, array{lengthM: int|float, laneUse: string}>|null  $turnLanes
     */
    private function applyArterialLaneUse(stdClass $config, string $nodeId, array $lanes, ?array $turnLanes): void
    {
        $arterial = collect($config->arterials ?? [])
            ->first(fn (stdClass $arterial) => collect($arterial->intersections ?? [])->contains('id', $nodeId))
            ?? throw new CorridorLaneUseException("No arterial intersection [{$nodeId}] in this corridor.");

        $this->ensureLaneCount($lanes, $arterial->lanes ?? 1, $nodeId);
        $node = collect($arterial->intersections)->firstWhere('id', $nodeId);
        $node->laneUse = $lanes;

        if ($turnLanes === null) {
            return;
        }

        $turnLanesObject = $this->turnLanesObject($turnLanes);
        if ($turnLanesObject === null) {
            unset($node->turnLanes);

            return;
        }

        $node->turnLanes = $turnLanesObject;
    }

    /**
     * @param  array<int, string>  $lanes
     * @param  array<string, array{lengthM: int|float, laneUse: string}>|null  $turnLanes
     */
    private function applyConnectorLaneUse(stdClass $config, string $nodeId, string $direction, array $lanes, ?array $turnLanes): void
    {
        // corridor.js gives a node the first connector that links it - match that.
        $connector = collect($config->connectors ?? [])
            ->first(fn (stdClass $connector) => in_array($nodeId, $connector->linksArterialNodes ?? [], true))
            ?? throw new CorridorLaneUseException("No cross street runs through [{$nodeId}] in this corridor.");

        $totalLanes = $connector->lanes ?? 2;
        $isTwoWay = $connector->twoWay ?? true;
        $label = "{$connector->id} at {$nodeId} {$direction}";
        $this->ensureLaneCount($lanes, $isTwoWay ? max(1, intdiv($totalLanes, 2)) : $totalLanes, $label);

        $connector->laneUse ??= new stdClass;
        $connector->laneUse->{$nodeId} ??= new stdClass;
        $connector->laneUse->{$nodeId}->{$direction} = $lanes;

        if ($turnLanes === null) {
            return;
        }

        $this->ensureRoomForMedianTurnLane($config, $connector, $turnLanes, $label);
        $this->setConnectorTurnLanes($connector, $nodeId, $direction, $this->turnLanesObject($turnLanes));
    }

    /** Writes (or, for null, removes) one direction's turn lanes, dropping any objects left empty. */
    private function setConnectorTurnLanes(stdClass $connector, string $nodeId, string $direction, ?stdClass $turnLanes): void
    {
        $connector->turnLanes ??= new stdClass;
        $connector->turnLanes->{$nodeId} ??= new stdClass;
        $connector->turnLanes->{$nodeId}->{$direction} = $turnLanes;

        if ($turnLanes === null) {
            unset($connector->turnLanes->{$nodeId}->{$direction});
        }
        if (get_object_vars($connector->turnLanes->{$nodeId}) === []) {
            unset($connector->turnLanes->{$nodeId});
        }
        if (get_object_vars($connector->turnLanes) === []) {
            unset($connector->turnLanes);
        }
    }

    /**
     * Turn lanes in the config's own shape, sides in a fixed order - null for none.
     *
     * @param  array<string, array{lengthM: int|float, laneUse: string}>  $turnLanes
     */
    private function turnLanesObject(array $turnLanes): ?stdClass
    {
        $sides = collect(TurnLaneSide::cases())
            ->filter(fn (TurnLaneSide $side) => isset($turnLanes[$side->value]))
            ->mapWithKeys(fn (TurnLaneSide $side) => [$side->value => (object) [
                'lengthM' => $turnLanes[$side->value]['lengthM'],
                'laneUse' => $turnLanes[$side->value]['laneUse'],
            ]]);

        return $sides->isEmpty() ? null : (object) $sides->all();
    }

    /**
     * A right (median-side) turn lane on a two-way street sits in the median, so the median has to be a lane wide.
     *
     * @param  array<string, array{lengthM: int|float, laneUse: string}>  $turnLanes
     */
    private function ensureRoomForMedianTurnLane(stdClass $config, stdClass $connector, array $turnLanes, string $label): void
    {
        $laneWidthM = $config->defaults->laneWidthM ?? 3.5;
        $isTwoWay = $connector->twoWay ?? true;
        $hasMedianTurnLane = isset($turnLanes[TurnLaneSide::Right->value]);

        if ($hasMedianTurnLane && $isTwoWay && ($connector->medianWidthM ?? 0) < $laneWidthM) {
            throw new CorridorLaneUseException("[{$label}] needs a median at least {$laneWidthM} m wide for a right turn lane.");
        }
    }

    /** @param  array<int, string>  $lanes */
    private function ensureLaneCount(array $lanes, int $expected, string $label): void
    {
        if (count($lanes) !== $expected) {
            throw new CorridorLaneUseException("[{$label}] has {$expected} lanes, got ".count($lanes).'.');
        }
    }
}
