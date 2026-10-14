<?php

namespace App\Http\Requests;

use App\Enums\BlockTier;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * Destinations edits from the Road Editor: tier changes per block, new blocks
 * between two points, and blocks removed - at least one of them. Whether each
 * fits the layout (block exists, points exist, id not taken) is CorridorRoutingTierEditor's check.
 */
class UpdateCorridorRoutingTiersRequest extends FormRequest
{
    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        $tiers = Rule::in(collect(BlockTier::cases())->map(fn (BlockTier $tier) => $tier->number())->all());

        return [
            'tiers' => ['required_without_all:add,remove', 'array'],
            'tiers.*.id' => ['required', 'string', 'max:255', 'distinct'],
            'tiers.*.tier' => ['required', 'numeric', $tiers],
            'add' => ['required_without_all:tiers,remove', 'array'],
            'add.*.id' => ['required', 'string', 'max:64', 'regex:/^[A-Za-z0-9_-]+$/', 'distinct'],
            'add.*.from' => ['required', 'string', 'max:255'],
            'add.*.to' => ['required', 'string', 'max:255'],
            'add.*.tier' => ['required', 'numeric', $tiers],
            'remove' => ['required_without_all:tiers,add', 'array'],
            'remove.*' => ['required', 'string', 'max:255', 'distinct'],
        ];
    }
}
