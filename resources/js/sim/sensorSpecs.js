/**
 * sensorSpecs.js - what each sensor type can observe (sensor overhaul, 2026-10-15).
 *
 * A sensor variant differs from another ONLY through its observation model: detection zones,
 * outputs, sampling period, latency and error model. engine.js turns a spec into one
 * observation frame per detector per tick (sensors.js's observeDetector()); the common demand
 * estimator and the shared gap-out rule then read those frames without asking which sensor
 * produced them.
 *
 * Distances are metres upstream of the stop line. Evidence rule: every number carries `source`
 * (URL + model), or `assumed`, or `derived` (follows from a published figure without being
 * stated), or `tuned` (no published figure exists; chosen by test runs). Assumed values are never tuned to make two
 * sensors differ.
 *
 * Spec fields:
 *   gapOut      - the detection zone that feeds the shared gap-out timer (any vehicle, moving or stopped).
 *   call        - the zone whose presence places a call (`stoppedOnly`: only a standing vehicle counts).
 *   queue       - the zone the queue count covers (stopped vehicles), or null when the sensor can't count.
 *   advance     - upstream zones: they also feed the gap-out timer, and a standing vehicle over one
 *                 reports the queue reaching back that far (`queueExtent`).
 *   footprint   - 'front': a vehicle is in a zone when its front is; 'body': when any part of it is.
 *   outputs     - which frame fields this sensor really produces; `count.filter` smooths the count.
 *   samplePeriodS - null: event-driven, read every tick; else held between samples.
 *   latency     - { ms, kind }: delay from the road to the controller, rounded UP to whole ticks.
 *   errors      - miss / false-call / crosstalk probabilities per frame and count noise; off unless the
 *                 run turns sensor errors on (`errorsAlwaysOn` only for the legacy reproduction).
 */

/** Gap-out zone every sensor shares: 0-8 m upstream of the line (a zone length, not a position). */
const SHARED_GAP_OUT = { startM: 0, lengthM: 8, source: 'assumed - the simulator\'s original stop-line detector footprint, kept for every sensor (decision 2026-10-15)' };

const NO_ERRORS = { missP: 0, falseCallP: 0, crosstalkP: 0, countNoise: null };

/**
 * Reproduces the pre-overhaul sensors.js exactly (trajectory hash unchanged): front-point zones,
 * no latency, radar's +/-1 count noise always on.
 */
const LEGACY = {
    inductive_loop: {
        gapOut: SHARED_GAP_OUT,
        call: { startM: 0, lengthM: 8, stoppedOnly: true },
        queue: null,
        advance: [],
        footprint: 'front',
        outputs: { presence: true, count: null, queueExtent: false, speed: false },
        samplePeriodS: null,
        latency: { ms: 0, kind: 'none' },
        errors: NO_ERRORS,
    },
    magnetometer: {
        gapOut: SHARED_GAP_OUT,
        call: { startM: 0, lengthM: 15, stoppedOnly: true },
        queue: null,
        advance: [{ centreM: 30, lengthM: 2 }],
        footprint: 'front',
        outputs: { presence: true, count: null, queueExtent: true, speed: false },
        samplePeriodS: null,
        latency: { ms: 0, kind: 'none' },
        errors: NO_ERRORS,
    },
    radar: {
        gapOut: SHARED_GAP_OUT,
        call: { startM: 0, lengthM: 60, stoppedOnly: true },
        queue: { startM: 0, lengthM: 60 },
        advance: [],
        footprint: 'front',
        outputs: { presence: true, count: { filter: { type: 'moving_average', windowS: 3 } }, queueExtent: false, speed: false },
        samplePeriodS: null,
        latency: { ms: 0, kind: 'none' },
        errors: { ...NO_ERRORS, countNoise: { type: 'uniform_int', amplitude: 1 } },
        errorsAlwaysOn: true,
    },
    camera: {
        gapOut: SHARED_GAP_OUT,
        call: { startM: 0, lengthM: 120, stoppedOnly: true },
        queue: { startM: 0, lengthM: 120 },
        advance: [],
        footprint: 'front',
        outputs: { presence: true, count: {}, queueExtent: false, speed: false },
        samplePeriodS: null,
        latency: { ms: 0, kind: 'none' },
        errors: NO_ERRORS,
    },
};

const FHWA_DETECTOR_HANDBOOK_CH4 = 'https://www.fhwa.dot.gov/publications/research/operations/ITS/06108/04.cfm';
const UMRR11_T132_SHEET = 'https://www.smartmicro.com/wp-content/uploads/2026/03/Product_Sheet_UMRR-11_Type_132_Traffic.pdf';
const SENSYS_RESOURCES = 'https://sensysnetworks.com/resources/';
const EDI_MODEL_222 = 'https://www.editraffic.com/products/model-222-vehicle-detector';

/**
 * The field-hardware models. Errors default to zero - they exist for deliberate sensitivity runs
 * only (engine reset `sensorErrors: true`), every probability being `assumed`.
 */
const FIELD = {
    inductive_loop: {
        gapOut: SHARED_GAP_OUT,
        call: {
            startM: 0,
            lengthM: 8,
            stoppedOnly: false,
            source: `${FHWA_DETECTOR_HANDBOOK_CH4} - FHWA Traffic Detector Handbook 3rd ed. (FHWA-HRT-06-108), long presence loop 6 ft wide x 20-80 ft; 8 m (26 ft) lies in that range`,
        },
        queue: null,
        advance: [],
        footprint: 'body',
        outputs: { presence: true, count: null, queueExtent: false, speed: false },
        samplePeriodS: null, // event-driven: the detector card reports on/off as it happens
        latency: { ms: 65, kind: 'detection_response', source: `${EDI_MODEL_222} - Eberle Design Model 222 datasheet, fail-safe mode response 65 +/- 25 ms` },
        errors: NO_ERRORS,
    },
    magnetometer: {
        gapOut: SHARED_GAP_OUT,
        call: {
            startM: 0,
            lengthM: 8,
            stoppedOnly: false,
            source: 'assumed - stop-bar pucks laid to cover the same 0-8 m presence footprint as the loop',
        },
        queue: null,
        advance: [{ centreM: 30, lengthM: 2, source: 'assumed, tuned - one advance puck 30 m upstream (about 2 s at 50-60 km/h), sensing about 2 m; no published placement exists, so the distance was chosen by test runs. Sensor modelled on Sensys Networks FlexMag (product page, FlexMag Flush and Deep Sensors datasheet): 3-axis magnetometer, 32/128 Hz sampling, advance-detection mode' }],
        footprint: 'body',
        outputs: { presence: true, count: null, queueExtent: true, speed: false },
        samplePeriodS: 1 / 128, // 7.8 ms
        samplePeriodSource: `${SENSYS_RESOURCES} - Sensys Networks technical resources: FlexMag 3-axis magnetometer sampled at 128 Hz (every 7.8 ms)`,
        latency: { ms: 125, kind: 'communications', source: `${SENSYS_RESOURCES} - Sensys Networks technical resources: 125 ms TDMA frames to the access point, so a detection waits up to one frame for its slot; a communications delay, not slower detection (excludes retransmission)` },
        errors: NO_ERRORS,
    },
    radar: {
        gapOut: SHARED_GAP_OUT,
        call: { startM: 0, lengthM: 60, stoppedOnly: true, source: `assumed - the simulator's 60 m radar window; inside the ${UMRR11_T132_SHEET} medium-range mode's 0.5-64 m detection range (smartmicro UMRR-11 Type 132)` },
        queue: { startM: 0, lengthM: 60 },
        advance: [],
        footprint: 'front', // a tracked object's reported range
        outputs: { presence: true, count: { filter: { type: 'moving_average', windowS: 3, source: 'assumed - the simulator\'s existing 3 s count smoothing, kept as the radar\'s processing' } }, queueExtent: false, speed: true },
        samplePeriodS: 0.055,
        samplePeriodSource: `${UMRR11_T132_SHEET} - smartmicro UMRR-11 Type 132, update cycle time 55 ms`,
        latency: { ms: 165, kind: 'processing', source: 'derived/assumed - 3 x 55 ms update cycles; the UMRR-11 Type 132 datasheet gives the 55 ms cycle and a processing latency of 2-4 cycles, the representative 3 is assumed' },
        errors: { ...NO_ERRORS, countNoise: { type: 'uniform_int', amplitude: 1, source: 'assumed - the simulator\'s original +/-1 count blur' } },
    },
    camera: {
        gapOut: SHARED_GAP_OUT,
        call: { startM: 0, lengthM: 120, stoppedOnly: true, source: 'assumed - the simulator\'s 120 m tracked region' },
        queue: { startM: 0, lengthM: 120 },
        advance: [],
        footprint: 'front', // a tracked bounding box's leading edge
        outputs: { presence: true, count: {}, queueExtent: false, speed: true },
        samplePeriodS: 1 / 17, // 58.8 ms
        samplePeriodSource: '"Evaluating Edge-Based YOLOv5-ByteTrack Frameworks for Real-Time Traffic Signal Control" (IEEE Big Data 2025, as cited) - YOLOv5 + ByteTrack + TensorRT on a Jetson Orin Nano, 17 FPS',
        latency: { ms: 30, kind: 'processing', source: 'same paper, as cited - 26-30 ms end-to-end latency for that Jetson Orin Nano pipeline; upper value used' },
        errors: NO_ERRORS,
    },
};

export const SENSOR_SPEC_SETS = { legacy: LEGACY, field: FIELD };
export const DEFAULT_SENSOR_SPEC_SET = 'field';

/** The spec sensor `mode` runs under spec set `set`. */
export function sensorSpecFor(mode, set = DEFAULT_SENSOR_SPEC_SET) {
    const specs = SENSOR_SPEC_SETS[set];
    if (!specs) throw new Error(`Unknown sensor spec set "${set}"`);
    return specs[mode] ?? specs.inductive_loop;
}

/** Latency in whole ticks, rounded up: a delay is never shorter than published. */
export function latencyTicks(spec, dt) {
    const ms = spec.latency?.ms ?? 0;
    return ms > 0 ? Math.ceil(ms / (dt * 1000) - 1e-9) : 0;
}

/** FNV-1a over `text` from offset basis `basis` - a stable 32-bit number, browser and Node alike. */
function fnv1a(text, basis) {
    let h = basis;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** JSON with keys sorted and citation text dropped: what the sensor does, not how it's documented. */
function behaviourJson(value) {
    if (Array.isArray(value)) return `[${value.map(behaviourJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).filter((k) => !/source$/i.test(k)).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${behaviourJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

/**
 * 16-hex fingerprint of the sensor configuration a run resolved to - its spec plus whether errors were on.
 * Recorded per run (simulation_runs.sensor_spec_hash) so a later edit to the field specs never passes for the
 * same configuration. Citation text doesn't count: re-sourcing a number leaves the hash alone.
 */
export function sensorSpecHash(spec, errorsOn) {
    const text = behaviourJson({ spec, errorsOn: !!errorsOn });
    return fnv1a(text, 0x811c9dc5).toString(16).padStart(8, '0') + fnv1a(text, 0x050c5d1f).toString(16).padStart(8, '0');
}
