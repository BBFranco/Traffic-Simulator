<?php

namespace App\Exceptions;

use Illuminate\Http\JsonResponse;
use RuntimeException;

/** A routing edit that doesn't fit the corridor it targets - no `routing` section, or a block id it doesn't have. */
class CorridorRoutingException extends RuntimeException
{
    public function render(): JsonResponse
    {
        return response()->json(['message' => $this->getMessage()], 422);
    }
}
