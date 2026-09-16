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
            // 8GB - a 15-min+ high-bitrate clip can land well past the spec's original
            // 500MB; kept in lockstep with php.ini's upload_max_filesize/post_max_size
            // and Herd's nginx client_max_body_size (both also 8192M) - this is the
            // innermost of the three, so it's the one that actually renders as a normal
            // 422 validation error instead of a raw 413 from a layer below it.
            'video' => ['required', 'file', 'mimetypes:video/mp4,video/quicktime,video/webm,video/x-msvideo', 'max:8388608'],
            'corridor_config' => ['required', 'string', 'max:255'],
            'street' => ['required', 'string', 'max:255'],
            'label' => ['nullable', 'string', 'max:255'],
            'line_coords' => ['required', 'json'],
            'save_annotated_video' => ['nullable', 'boolean'],
        ];
    }
}
