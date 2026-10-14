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

/** runHeadless() cases whose summary must stay byte-identical: warm-up, outage window, both routing modes. */
export const SUMMARY_MATRIX = [];
for (const seed of [1, 2]) {
    for (const controllerMode of ['fixed', 'adaptive', 'green_wave']) {
        SUMMARY_MATRIX.push({ seed, controllerMode, routingMode: 'random', outage: true });
    }
    SUMMARY_MATRIX.push({ seed, controllerMode: 'fixed', routingMode: 'destination', outage: false });
}

export function caseKey(c) {
    return Object.values(c).join('|');
}

export function summaryArgs(c, corridorConfig) {
    return {
        seed: c.seed,
        controllerMode: c.controllerMode,
        sensorMode: 'inductive_loop',
        warmupTicks: 1200,
        powerOutageStartTick: c.outage ? 1500 : null,
        powerOutageEndTick: c.outage ? 3000 : null,
        corridorConfig,
        durationTicks: 4800,
        routingMode: c.routingMode,
    };
}

/** The per-tick CSV rows (rows, sideStreetRows, totalRows, arterialScopeRows) also read snapshot(). */
export function rowsHash(rowGroups) {
    return createHash('sha1').update(JSON.stringify(rowGroups)).digest('hex').slice(0, 16);
}
