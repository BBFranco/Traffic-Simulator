<?php

namespace App\Support;

use JsonException;
use RuntimeException;

/**
 * Reads the corridor layout configs in `corridors/*.json`.
 *
 * The layouts deliberately live outside `public/` and outside the JS bundle:
 * they are data the batch runner (build step 17) also has to read from disk, so
 * one directory is the single source of truth for both the browser and Node.
 * The browser gets them through `GET /corridors/{id}`.
 */
class CorridorRepository
{
    public function __construct(private ?string $directory = null)
    {
        $this->directory = $this->directory ?? base_path('corridors');
    }

    /**
     * Every available corridor, as lightweight descriptors for the scenario picker.
     *
     * @return array<int, array{id: string, name: string, description: string, intersections: int, arterials: int, connectors: int}>
     */
    public function index(): array
    {
        $descriptors = [];

        foreach ($this->files() as $path) {
            $config = $this->decode($path);
            $id = $config['id'] ?? pathinfo($path, PATHINFO_FILENAME);

            $intersections = 0;
            foreach ($config['arterials'] ?? [] as $arterial) {
                $intersections += count($arterial['intersections'] ?? []);
            }

            $descriptors[] = [
                'id' => $id,
                'name' => $config['name'] ?? $id,
                'description' => $config['description'] ?? '',
                'sortOrder' => $config['sortOrder'] ?? 99,
                'arterials' => count($config['arterials'] ?? []),
                'connectors' => count($config['connectors'] ?? []),
                'intersections' => $intersections,
            ];
        }

        usort($descriptors, fn ($a, $b) => [$a['sortOrder'], $a['name']] <=> [$b['sortOrder'], $b['name']]);

        return $descriptors;
    }

    /** The first corridor by sort order - what `/simulator` loads on arrival. */
    public function defaultId(): ?string
    {
        return $this->index()[0]['id'] ?? null;
    }

    /**
     * Full config for one corridor.
     *
     * @return array<string, mixed>|null
     */
    public function find(string $id): ?array
    {
        foreach ($this->files() as $path) {
            $config = $this->decode($path);
            if (($config['id'] ?? pathinfo($path, PATHINFO_FILENAME)) === $id) {
                return $config;
            }
        }

        return null;
    }

    /** @return array<int, string> */
    private function files(): array
    {
        if (! is_dir($this->directory)) {
            throw new RuntimeException("Corridor directory not found: {$this->directory}");
        }

        return glob($this->directory.DIRECTORY_SEPARATOR.'*.json') ?: [];
    }

    /** @return array<string, mixed> */
    private function decode(string $path): array
    {
        try {
            $decoded = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException $e) {
            throw new RuntimeException("Corridor config {$path} is not valid JSON: {$e->getMessage()}", 0, $e);
        }

        return is_array($decoded) ? $decoded : [];
    }
}
