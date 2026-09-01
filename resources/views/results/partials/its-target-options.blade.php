{{-- "Compare against fixed-time" select options - shared by the initial render and ResultsController::data()'s AJAX refresh. --}}
@foreach ($comparisonOptions as $option)
    <option value="{{ $option['key'] }}">{{ $option['label'] }}</option>
@endforeach
