/**
 * demandProfile.js - demand as a function of time of day, for the long-outage protocol (dissertation plan step 7.2).
 *
 * The corridor's own demand is the PM peak. A profile scales every arrival rate - map-edge spawns, side streets, and
 * through them the driveway departures - by `%(clock) / peakPct`, on top of the 300 s fluctuation
 * (engine.js's _liveSpawnRate()). Webster's plans are not re-timed: fixed-time and green wave keep their one peak plan
 * all evening (Franco, 2026-10-23), as a single-plan controller would.
 *
 * EVENING_PROFILE is Joubert, Burnett and Ueckermann (2000), Figure 5: the % of daily traffic in each hour of a weekday
 * on Johannesburg suburban roads (read off the chart, about +-0.2). Each value is the hour starting there, so it is
 * placed at the hour's middle and interpolated linearly between middles; before the first or after the last middle it
 * holds that hour's value.
 */
export const EVENING_PROFILE = {
    id: 'joubert2000-evening',
    peakPct: 8.9,
    hourPct: { 15: 5.5, 16: 6.0, 17: 8.8, 18: 8.9, 19: 6.2, 20: 3.9, 21: 2.7, 22: 1.8, 23: 1.7 },
};

/** The demand multiplier at `clockS` seconds after midnight under `profile` (1 = the corridor's own, peak, demand). */
export function profileMultiplier(profile, clockS) {
    const points = Object.entries(profile.hourPct)
        .map(([hour, pct]) => ({ atS: (Number(hour) + 0.5) * 3600, pct }))
        .sort((a, b) => a.atS - b.atS);
    if (clockS <= points[0].atS) return points[0].pct / profile.peakPct;
    for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1];
        const b = points[i];
        if (clockS <= b.atS) return (a.pct + ((b.pct - a.pct) * (clockS - a.atS)) / (b.atS - a.atS)) / profile.peakPct;
    }
    return points[points.length - 1].pct / profile.peakPct;
}

/**
 * The time-of-day plan sensitivity (dissertation plan, after Phase 4): the demand a fixed-time plan in force at `clockS` is
 * timed for - the share of the clock hour it falls in, as a multiple of the peak. Plans change on the hour, each timed to
 * its own hour's flow, which is the best a time-of-day schedule could do with this profile.
 */
export function hourPlanMultiplier(profile, clockS) {
    const hour = Math.floor(clockS / 3600) % 24;
    const hours = Object.keys(profile.hourPct).map(Number).sort((a, b) => a - b);
    const held = hour < hours[0] ? hours[0] : hour > hours[hours.length - 1] ? hours[hours.length - 1] : hour;
    return profile.hourPct[held] / profile.peakPct;
}

/** "16:15" for 58500 s. */
export function clockLabel(clockS) {
    const minutes = Math.round(clockS / 60);
    return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
