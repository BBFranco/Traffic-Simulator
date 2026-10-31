<?php

namespace App\Http\Requests;

use App\Enums\LaneUseApproach;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * The Road Editor's slip lanes - the whole set, drawn in the browser by resources/js/sim/slipLanes.js:
 * which approaches have one, their `slip_` connectors and the joins that tie them to their roads. It
 * replaces whatever slip lanes the layout had; whether it fits the corridor is CorridorSlipLaneEditor's check.
 */
class UpdateCorridorSlipLanesRequest extends FormRequest
{
    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'slipLanes' => ['present', 'array'],
            'slipLanes.*.nodeId' => ['required', 'string', 'max:255'],
            'slipLanes.*.direction' => ['required', Rule::enum(LaneUseApproach::class)->except(LaneUseApproach::Arterial)],
            'slipLanes.*.backM' => ['required', 'numeric', 'gt:0', 'max:500'],

            'connectors' => ['present', 'array'],
            'connectors.*.id' => ['required', 'string', 'max:255', 'starts_with:slip_'],
            'connectors.*.mode' => ['required', 'string', 'max:32'],
            'connectors.*.name' => ['present', 'nullable', 'string', 'max:255'],
            'connectors.*.curve' => ['required', 'array', 'min:3'],
            'connectors.*.curve.*.xM' => ['required', 'numeric'],
            'connectors.*.curve.*.yM' => ['required', 'numeric'],
            'connectors.*.lanes' => ['required', 'integer', 'min:1', 'max:2'],
            'connectors.*.twoWay' => ['required', 'boolean'],
            'connectors.*.turnChance' => ['required', 'numeric', 'between:0,1'],
            'connectors.*.crossChance' => ['required', 'numeric', 'between:0,1'],
            'connectors.*.targetSpeedKph' => ['required', 'numeric', 'gt:0', 'max:120'],

            'joins' => ['present', 'array'],
            'joins.*.from' => ['required', 'string', 'max:255'],
            'joins.*.to' => ['required', 'string', 'max:255'],
            'joins.*.fromAtM' => ['sometimes', 'numeric', 'min:0'],
            'joins.*.toAtM' => ['sometimes', 'numeric', 'min:0'],
            'joins.*.slip' => ['sometimes', 'accepted'],
        ];
    }
}
