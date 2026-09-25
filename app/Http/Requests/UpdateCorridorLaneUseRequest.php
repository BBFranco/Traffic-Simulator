<?php

namespace App\Http\Requests;

use App\Enums\LaneUseApproach;
use App\Enums\TurnLaneSide;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Lane-use edits from the road editor - one entry per edited approach, lanes
 * kerb first, in the corridor JSON's own token form ("left", "straight_right",
 * "all"), plus optionally the approach's turn lanes (`{}` for none, left out to
 * leave them as they are). Whether each entry fits the corridor (node exists,
 * lane count matches, room for a median-side turn lane) is CorridorRepository's check.
 */
class UpdateCorridorLaneUseRequest extends FormRequest
{
    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        $sides = collect(TurnLaneSide::cases())->pluck('value')->implode(',');

        return [
            'approaches' => ['required', 'array', 'min:1'],
            'approaches.*.nodeId' => ['required', 'string', 'max:255'],
            'approaches.*.key' => ['required', Rule::enum(LaneUseApproach::class)],
            'approaches.*.lanes' => ['required', 'array', 'min:1'],
            'approaches.*.lanes.*' => ['required', 'string', 'regex:/^(all|(left|straight|right)(_(left|straight|right))*)$/'],
            'approaches.*.turnLanes' => ['sometimes', 'array:'.$sides],
            'approaches.*.turnLanes.*' => ['array:lengthM,laneUse'],
            'approaches.*.turnLanes.*.lengthM' => ['required', 'numeric', 'gt:0', 'max:500'],
            // A turn lane is for turning only - never straight.
            'approaches.*.turnLanes.*.laneUse' => ['required', 'string', 'regex:/^(left|right|left_right)$/'],
        ];
    }
}
