<?php

namespace App\Http\Requests;

use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Validates the upload + user-drawn counting line for a new traffic count
 * (Traffic Counter spec §4). `line_coords` arrives as a JSON string field
 * (multipart requests can't nest arrays under a file upload the way a plain
 * JSON body can), already scaled to the video's native pixel space by the
 * client before it's sent.
 */
class StoreTrafficCountRequest extends FormRequest
{
    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'video' => ['required', 'file', 'mimetypes:video/mp4,video/quicktime,video/webm,video/x-msvideo', 'max:512000'],
            'corridor_config' => ['required', 'string', 'max:255'],
            'street' => ['required', 'string', 'max:255'],
            'label' => ['nullable', 'string', 'max:255'],
            'line_coords' => ['required', 'json'],
            'save_annotated_video' => ['nullable', 'boolean'],
        ];
    }
}
