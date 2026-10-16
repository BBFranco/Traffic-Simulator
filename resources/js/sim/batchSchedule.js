/**
 * batchSchedule.js - the measured window and outage schedule every batch run uses, shared by batch/runBatch.mjs and
 * the /results batch button (results.js) so the two can't drift apart. Ticks are MEASURED ticks at dt = 0.1 s
 * (warm-up runs before them and isn't counted).
 *
 * 90 measured minutes: 15 min before the cut, 15 min dark, then 60 min after power returns. Fixed-time drains most of
 * its post-outage backlog in the first 30 min and then levels off (scripts/preview/recoveryprobe.mjs, 2026-10-12);
 * a 60 min window cut that drain off at 30 min. The outage stays at a fixed 15-30 min - only the tail grew.
 */
export const MEASURED_TICKS = 54000;
export const POWER_OUTAGE_START_TICK = 9000;
export const POWER_OUTAGE_END_TICK = 18000;

/**
 * The rolling blackout (power state 'rolling_blackout'): zones 1 and 3 dark 15-30 min, then zone 2 dark 30-45 min, all
 * lit from 45 min - same measured window. Each window's zones are the layout's `zone`s (scripts/add-zones.mjs). The
 * simulator page's checkbox plays the same windows from the moment it is ticked, as offsets from the first one.
 */
export const ROLLING_SCHEDULE = [
    { zones: [1, 3], fromTick: 9000, toTick: 18000 },
    { zones: [2], fromTick: 18000, toTick: 27000 },
];
