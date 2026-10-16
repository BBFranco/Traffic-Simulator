import { createHash } from 'node:crypto';

/**
 * The run matrix the dynamics-neutral baselines were captured on (Live Statistics overhaul).
 * Changing it means recapturing the baselines on the pre-change build.
 */
export const HASH_CORRIDOR = 'hatfield-realistic';
export const HASH_TICKS = 6000;
export const HASH_MATRIX = [];
for (const seed of [1, 2, 3]) {
    for (const controllerMode of ['fixed', 'adaptive', 'green_wave']) {
        for (const loadShedding of [false, true]) HASH_MATRIX.push({ seed, controllerMode, loadShedding, routingMode: null });
    }
}
for (const seed of [1, 2]) HASH_MATRIX.push({ seed, controllerMode: 'fixed', loadShedding: false, routingMode: 'destination' });
// Coordinated adaptive (added 2026-10-14) - every layer on; its keys were captured on their own, the rest untouched.
for (const seed of [1, 2]) {
    for (const loadShedding of [false, true]) HASH_MATRIX.push({ seed, controllerMode: 'coordinated_adaptive', loadShedding, routingMode: null });
}
HASH_MATRIX.push({ seed: 1, controllerMode: 'coordinated_adaptive', loadShedding: false, routingMode: 'destination' });
// The other sensor modes (added 2026-10-15, sensor overhaul step 0) - every case above runs the default inductive_loop.
// Only the actuated controllers read sensors. Radar's keys captured before its noise left the main RNG are kept in
// trajectoryHash.radarPreSubstream.json, the record of that one deliberate change.
for (const sensorMode of ['magnetometer', 'radar', 'camera']) {
    for (const seed of [1, 2]) {
        for (const controllerMode of ['adaptive', 'coordinated_adaptive']) HASH_MATRIX.push({ seed, controllerMode, loadShedding: false, routingMode: null, sensorMode });
    }
}
// The 'legacy' sensor spec set must keep reproducing the pre-overhaul sensors: these keys hold the step-0 hashes
// (radar's from after its noise moved to its own streams - the one deliberate change, see trajectoryHash.radarPreSubstream.json).
for (const sensorMode of ['inductive_loop', 'magnetometer', 'radar', 'camera']) {
    for (const controllerMode of ['adaptive', 'coordinated_adaptive']) HASH_MATRIX.push({ seed: 1, controllerMode, loadShedding: false, routingMode: null, sensorMode, sensorSpecSet: 'legacy' });
}

// Rolling blackout (added 2026-10-16) - its keys captured on their own, the rest untouched.
for (const controllerMode of ['fixed', 'green_wave', 'adaptive', 'coordinated_adaptive']) HASH_MATRIX.push({ seed: 1, controllerMode, loadShedding: false, routingMode: null, rolling: true });
HASH_MATRIX.push({ seed: 1, controllerMode: 'coordinated_adaptive', loadShedding: false, routingMode: 'destination', rolling: true });

/** runHeadless() cases whose summary must stay byte-identical: warm-up, outage window, both routing modes. */
export const SUMMARY_MATRIX = [];
for (const seed of [1, 2]) {
    for (const controllerMode of ['fixed', 'adaptive', 'green_wave']) {
        SUMMARY_MATRIX.push({ seed, controllerMode, routingMode: 'random', outage: true });
    }
    SUMMARY_MATRIX.push({ seed, controllerMode: 'fixed', routingMode: 'destination', outage: false });
}
for (const seed of [1, 2]) SUMMARY_MATRIX.push({ seed, controllerMode: 'coordinated_adaptive', routingMode: 'destination', outage: true });
for (const sensorMode of ['magnetometer', 'radar', 'camera']) SUMMARY_MATRIX.push({ seed: 1, controllerMode: 'adaptive', routingMode: 'destination', outage: true, sensorMode });
// Rolling blackout (added 2026-10-16): the same 1500-3000 outage span, split into its two stages.
for (const controllerMode of ['fixed', 'coordinated_adaptive']) SUMMARY_MATRIX.push({ seed: 1, controllerMode, routingMode: 'destination', outage: false, rolling: true });

export function caseKey(c) {
    return Object.values(c).join('|');
}

export function summaryArgs(c, corridorConfig) {
    return {
        seed: c.seed,
        controllerMode: c.controllerMode,
        sensorMode: c.sensorMode ?? 'inductive_loop',
        warmupTicks: 1200,
        powerOutageStartTick: c.outage ? 1500 : null,
        powerOutageEndTick: c.outage ? 3000 : null,
        rollingSchedule: c.rolling ? [{ zones: [1, 3], fromTick: 1500, toTick: 2250 }, { zones: [2], fromTick: 2250, toTick: 3000 }] : null,
        corridorConfig,
        durationTicks: 4800,
        routingMode: c.routingMode,
    };
}

/** The per-tick CSV rows (rows, sideStreetRows, totalRows, arterialScopeRows) also read snapshot(). */
export function rowsHash(rowGroups) {
    return createHash('sha1').update(JSON.stringify(rowGroups)).digest('hex').slice(0, 16);
}
