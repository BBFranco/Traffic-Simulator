<?php

namespace App\Support;

/**
 * The lightweight summary of a corridor config a layout picker shows - shared
 * by the file templates (CorridorRepository) and users' own layouts (UserCorridorLayouts).
 */
final class CorridorDescriptor
{
    /**
     * @param  array<string, mixed>  $config
     * @return array{id: string, name: string, description: string, sortOrder: int, arterials: int, connectors: int, intersections: int}
     */
    public static function fromConfig(array $config, string $id): array
    {
        $arterials = collect($config['arterials'] ?? []);

        return [
            'id' => $id,
            'name' => $config['name'] ?? $id,
            'description' => $config['description'] ?? '',
            'sortOrder' => $config['sortOrder'] ?? 99,
            'arterials' => $arterials->count(),
            'connectors' => count($config['connectors'] ?? []),
            'intersections' => $arterials->sum(fn (array $arterial) => count($arterial['intersections'] ?? [])),
        ];
    }
}
