<?php

namespace App\Support;

use JsonException;
use RuntimeException;
use stdClass;

/**
 * Reads the corridor layout configs in `corridors/*.json` - the shared
 * templates, only ever rewritten from the Road Editor's "Use for batches".
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

    /** Overwrites one template's file with `$config`, keeping the template's own id and the file's key order (the database scrambles it, which would turn a one-line edit into a whole-file diff). False if there is no such template. */
    public function replace(string $id, stdClass $config): bool
    {
        $path = $this->pathFor($id);
        if ($path === null) {
            return false;
        }

        $config->id = $id;
        $ordered = $this->inOrderOf(json_decode((string) file_get_contents($path), false), $config);
        file_put_contents($path, json_encode($ordered, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR)."
");

        return true;
    }

    /** `$config` with its keys in the order `$reference` has them (new keys last); arrays of objects are matched up by `id`. */
    private function inOrderOf(mixed $reference, mixed $config): mixed
    {
        if (is_array($config)) {
            $referenceById = collect(is_array($reference) ? $reference : [])
                ->filter(fn (mixed $item) => $item instanceof stdClass && isset($item->id))
                ->keyBy('id');

            return collect($config)
                ->map(fn (mixed $item) => $this->inOrderOf($item instanceof stdClass ? $referenceById->get($item->id ?? null) : null, $item))
                ->all();
        }

        if (! $config instanceof stdClass) {
            return $config;
        }

        $reference = $reference instanceof stdClass ? $reference : new stdClass;
        $knownKeys = collect(array_keys(get_object_vars($reference)))->filter(fn (string|int $key) => property_exists($config, (string) $key));
        $newKeys = collect(array_keys(get_object_vars($config)))->diff($knownKeys);

        $ordered = new stdClass;
        foreach ($knownKeys->concat($newKeys) as $key) {
            $ordered->{$key} = $this->inOrderOf($reference->{$key} ?? null, $config->{$key});
        }

        return $ordered;
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
