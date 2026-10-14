/**
 * definitions.js - the one definition of every traffic metric the simulator shows or reports.
 *
 * The live statistics panel (liveMetrics.js), the engine's per-frame snapshot() and the batch
 * summary (runHeadless.js) all call these, so a number on screen and the same number in the
 * Results report can never drift apart. Pure functions over plain counters, no engine import.
 *
 * Wait is always the engine's trip-carried accounting (engine.js WAIT_ACCOUNTING): a vehicle's
 * wait travels with it through every turn and is counted once, when it leaves the network.
 */
import { STOPPED_SPEED_MPS } from '../car.js';
import { LOCKUP_STILL_S } from '../lockupWatch.js';

/** Below this a vehicle is stopped - the same threshold its wait accrues under (car.js). */
export const STOP_SPEED_MPS = STOPPED_SPEED_MPS;
/** Standing still continuously this long makes a vehicle stranded - lockupWatch.js's own limit and clock. */
export const STRANDED_S = LOCKUP_STILL_S;
/** A vehicle in a junction, stopped this long, blocks it. */
export const BLOCKED_BOX_S = 10;
/** engine.js's rolling window: "cleared in the window" is then cleared per minute. */
export const ROLLING_WINDOW_S = 60;
/** Drift: the trend of the rolling avg wait over the last 10 min, in 1 min window means. */
export const DRIFT_LOOKBACK_S = 600;
export const DRIFT_WINDOW_S = 60;
const DRIFT_MIN_WINDOWS = 5;

/** Mean wait per cleared vehicle (s). 0 before anything has cleared, as the report has always stored it. */
export function avgWait(waitSumS, cleared) {
    return cleared ? waitSumS / cleared : 0;
}

/** Vehicles cleared per minute over `seconds`. */
export function throughputPerMin(cleared, seconds) {
    return cleared / (seconds / 60);
}

/** Share of cleared vehicles that never stopped (%), null before anything has cleared. */
export function zeroStopPct(clearedWithoutStop, cleared) {
    return cleared ? (clearedWithoutStop / cleared) * 100 : null;
}

/** Mean wait of the vehicles cleared in the rolling window (`recentClears`, `{tS, waitS}`). */
export function rollingAvgWait(recentClears) {
    return recentClears.length ? recentClears.reduce((s, c) => s + c.waitS, 0) / recentClears.length : 0;
}

/** Vehicles cleared in the rolling window - per minute, since the window is 60 s. */
export function rollingThroughputPerMin(recentClears) {
    return recentClears.length;
}

/** Mean wait so far of the vehicles stopped right now (s). */
export function avgWaitNow(stoppedCars) {
    return stoppedCars.length ? stoppedCars.reduce((s, c) => s + c.totalWaitS, 0) / stoppedCars.length : 0;
}

export function isStopped(speedMps) {
    return speedMps < STOP_SPEED_MPS;
}

/** `stillS`: how long the vehicle has stood still without a break (lockupWatch.js's clock). */
export function isStranded(stillS) {
    return stillS >= STRANDED_S;
}

export function isBoxBlocked(stoppedForS) {
    return stoppedForS > BLOCKED_BOX_S;
}

/** Stops (a drop below STOP_SPEED_MPS after being above it) per cleared vehicle. */
export function avgStopsPerVehicle(stops, cleared) {
    return cleared ? stops / cleared : null;
}

/** Share of signal-approach stop-line crossings made on green without having stopped on that approach (%). */
export function arrivalsOnGreenPct(onGreen, arrivals) {
    return arrivals ? (onGreen / arrivals) * 100 : null;
}

export function densityVehPerKm(vehicles, laneKm) {
    return laneKm > 0 ? vehicles / laneKm : 0;
}

/** `value` as a percentage of `base`, null without a base. */
export function pctOf(value, base) {
    return base > 0 ? (value / base) * 100 : null;
}

/* ------------------------------------------------------------- routing */

export function meanTripS(stats) {
    return stats.trips ? stats.tripTimeSumS / stats.trips : null;
}

/** Time beyond free flow along the route, over the trips that reached the destination they set out for. */
export function meanTripDelayS(stats) {
    return stats.tripsOnPlan ? stats.tripDelaySumS / stats.tripsOnPlan : null;
}

export function divertedPct(stats) {
    return stats.trips ? (stats.diverted / stats.trips) * 100 : null;
}

/** Missed driveways over pulled-off trips (%), as app/Support/RoutingMetrics.php sums it. */
export function missedDrivewaysPct(stats) {
    return stats.pulledOff ? (stats.missedDriveways / stats.pulledOff) * 100 : null;
}

/** Mean time a car that pulled out had waited in its driveway first (s). */
export function meanDrivewayWaitS(stats) {
    return stats.departed ? stats.drivewayWaitSumS / stats.departed : null;
}

export function carsInDriveways(departures) {
    return departures.reduce((sum, d) => sum + d.waiting.length, 0);
}

/* --------------------------------------------------------------- drift */

/** Least-squares slope of `values` against their index, with its t statistic. */
export function trend(values) {
    const n = values.length;
    const meanX = (n - 1) / 2;
    const meanY = values.reduce((a, b) => a + b, 0) / n;
    let sxx = 0;
    let sxy = 0;
    values.forEach((y, x) => {
        sxx += (x - meanX) ** 2;
        sxy += (x - meanX) * (y - meanY);
    });
    const slope = sxy / sxx;
    const residual = values.reduce((sum, y, x) => sum + (y - meanY - slope * (x - meanX)) ** 2, 0);
    const slopeSe = n > 2 ? Math.sqrt(residual / (n - 2) / sxx) : Infinity;
    return { slope, meanY, t: slopeSe > 0 ? slope / slopeSe : slope === 0 ? 0 : Infinity };
}

/** The warm-up probe's settled test (plateau.js): drift over the horizon within `tolerance` of the mean, or no trend beyond noise. */
export function trendSettled({ slope, meanY, t }, horizonWindows, tolerance = 0.15) {
    const driftRatio = meanY === 0 ? (slope === 0 ? 0 : Infinity) : Math.abs(slope * horizonWindows) / Math.abs(meanY);
    return { driftRatio, settled: driftRatio <= tolerance || Math.abs(t) < 2 };
}

/**
 * 'settling' | 'settled' | 'drifting' for a 1 Hz series of the rolling avg wait (`values`, oldest
 * first): the last DRIFT_LOOKBACK_S cut into DRIFT_WINDOW_S means, tested like the warm-up probe.
 */
export function driftState(values) {
    const recent = values.slice(-DRIFT_LOOKBACK_S);
    const means = [];
    for (let i = 0; i + DRIFT_WINDOW_S <= recent.length; i += DRIFT_WINDOW_S) {
        means.push(recent.slice(i, i + DRIFT_WINDOW_S).reduce((a, b) => a + b, 0) / DRIFT_WINDOW_S);
    }
    if (means.length < DRIFT_MIN_WINDOWS) return { state: 'settling', driftRatio: null };
    const { driftRatio, settled } = trendSettled(trend(means), means.length);
    return { state: settled ? 'settled' : 'drifting', driftRatio };
}
