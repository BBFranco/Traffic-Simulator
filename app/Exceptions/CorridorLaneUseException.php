<?php

namespace App\Exceptions;

use Illuminate\Http\JsonResponse;
use RuntimeException;

/** A lane-use edit that doesn't fit the corridor it targets - unknown node, the wrong number of lanes, or no room for a turn lane. */
class CorridorLaneUseException extends RuntimeException
{
    public function render(): JsonResponse
    {
        return response()->json(['message' => $this->getMessage()], 422);
    }
}
