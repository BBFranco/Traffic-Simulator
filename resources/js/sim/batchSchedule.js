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

/**
 * The long-outage protocol (dissertation plan steps 7-8, 2026-10-23): real-duration outages over an evening. 375
 * measured minutes, 16:15-22:30: 15 min before the cut at 16:30, 4 h dark (the total blackout) or zones 1+3 dark 2 h then
 * zone 2 dark 2 h (load shedding), then 2 h after the final restore. Demand follows demandProfile.js's EVENING_PROFILE,
 * the corridor's own demand being the peak. Normal-power runs use the same window, so the seeds still pair.
 *
 * Rows are sampled every 5 s, not 1 s: a 375-min run at 1 s would hold ~22,500 samples per scope. Every summary stat is
 * a cumulative counter or a 60 s rolling value, and recovery smooths over 300 s, so 5 s loses nothing they read.
 * Ticks are measured ticks at dt = 0.1 s, as above.
 */
const MIN = 600;
export const LONG_PROTOCOL = {
    id: 'long-evening-v1',
    measuredTicks: 375 * MIN,
    powerOutageStartTick: 15 * MIN,
    powerOutageEndTick: (15 + 240) * MIN,
    rollingSchedule: [
        { zones: [1, 3], fromTick: 15 * MIN, toTick: (15 + 120) * MIN },
        { zones: [2], fromTick: (15 + 120) * MIN, toTick: (15 + 240) * MIN },
    ],
    /** 16:15 - the clock at measured tick 0. */
    startClockS: 16.25 * 3600,
    sampleEverySeconds: 5,
};
