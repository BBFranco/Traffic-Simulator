<?php

namespace App\Http\Requests;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;
use JsonException;
use stdClass;

/**
 * A road layout imported in the Road Editor: one corridor JSON file, the shape
 * of `corridors/*.json`. Only the outline is checked here (an object with
 * arterials, each with intersections) - the browser runs the full layout
 * loader over the file before it uploads it.
 */
class StoreCorridorLayoutRequest extends FormRequest
{
    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'layout' => ['required', 'file', 'max:2048', 'extensions:json'],
        ];
    }

    /** @return array<int, Closure> */
    public function after(): array
    {
        return [
            function (Validator $validator) {
                if ($validator->errors()->isNotEmpty()) {
                    return;
                }

                $problem = $this->layoutProblem();
                if ($problem !== null) {
                    $validator->errors()->add('layout', $problem);
                }
            },
        ];
    }

    /** The uploaded layout, decoded as objects so an empty `{}` stays an object. */
    public function layoutConfig(): stdClass
    {
        return json_decode((string) $this->file('layout')->get(), false, 512, JSON_THROW_ON_ERROR);
    }

    private function layoutProblem(): ?string
    {
        try {
            $config = $this->layoutConfig();
        } catch (JsonException) {
            return 'That file is not valid JSON.';
        }

        if (! is_array($config->arterials ?? null) || $config->arterials === []) {
            return 'A road layout needs an "arterials" list - see corridors/hatfield-pretorius-francisbaard.json for the shape.';
        }

        $hasIntersections = collect($config->arterials)
            ->every(fn (mixed $arterial) => $arterial instanceof stdClass && is_array($arterial->intersections ?? null) && $arterial->intersections !== []);

        return $hasIntersections ? null : 'Every arterial needs at least one intersection.';
    }
}
