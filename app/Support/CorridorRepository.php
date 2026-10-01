<?php

namespace App\Support;

use JsonException;
use RuntimeException;

/**
 * Reads the corridor layout configs in `corridors/*.json` - the shared,
 * read-only templates.
 *
 * They deliberately live outside `public/` and outside the JS bundle: they are
 * data the batch runner (build step 17) also has to read from disk, so one
 * directory is the single source of truth for the dissertation dataset - the
 * Results and Traffic Counter pages use them through
 * `GET /corridor-templates/{id}`. Each user's own, editable layouts live in the
 * database instead (UserCorridorLayouts); a new account starts with a copy of
 * the standard Hatfield template.
 */
class CorridorRepository
{
    public function __construct(private ?string $directory = null)
    {
        $this->directory = $this->directory ?? base_path('corridors');
    }

    /**
     * Every template, as lightweight descriptors for a picker.
     *
     * @return array<int, array{id: string, name: string, description: string, sortOrder: int, arterials: int, connectors: int, intersections: int}>
     */
    public function index(): array
    {
        return collect($this->files())
            ->map(function (string $path) {
                $config = $this->decode($path);

                return CorridorDescriptor::fromConfig($config, $config['id'] ?? pathinfo($path, PATHINFO_FILENAME));
            })
            ->sortBy([['sortOrder', 'asc'], ['name', 'asc']])
            ->values()
            ->all();
    }

    /** The first template by sort order. */
    public function defaultId(): ?string
    {
        return $this->index()[0]['id'] ?? null;
    }

    /**
     * Full config for one template.
     *
     * @return array<string, mixed>|null
     */
    public function find(string $id): ?array
    {
        $path = $this->pathFor($id);

        return $path === null ? null : $this->decode($path);
    }

    /** One template's file contents as written - decoded by the caller however it needs (e.g. as objects, to keep `{}` intact). */
    public function raw(string $id): ?string
    {
        $path = $this->pathFor($id);

        return $path === null ? null : (string) file_get_contents($path);
    }

    private function pathFor(string $id): ?string
    {
        // Almost every template is named after its own id - skip decoding the rest.
        $named = $this->directory.DIRECTORY_SEPARATOR.basename($id).'.json';
        if (is_file($named) && ($this->decode($named)['id'] ?? $id) === $id) {
            return $named;
        }

        return collect($this->files())
            ->first(fn (string $path) => ($this->decode($path)['id'] ?? pathinfo($path, PATHINFO_FILENAME)) === $id);
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
