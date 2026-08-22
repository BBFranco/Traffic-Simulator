/**
 * equations.js - single source of truth for every cited formula used by the
 * simulation (car movement, signal timing, sensor logic, arrivals).
 *
 * Every formula here is transcribed from a cited source, not derived or
 * approximated. Cross-check any edit against the citation before merging.
 * Other modules import from here and call these functions - they do not
 * reimplement or inline the maths themselves.
 */

// ---------------------------------------------------------------------
// Intelligent Driver Model (IDM)
// Treiber, M., Hennecke, A. & Helbing, D., 2000. Congested Traffic States
// in Empirical Observations and Microscopic Simulations. Physical Review E,
// 62(2), pp. 1805-1824.
//
// Acceleration:
//   a_alpha = a * [ 1 - (v/v0)^delta - (sStar(v, dv) / s)^2 ]
// Desired minimum gap:
//   sStar(v, dv) = s0 + v*T + (v*dv) / (2 * sqrt(a*b))
//
// v      : current speed of this car (m/s)
// v0     : desired (free-flow) speed for this car (m/s)
// dv     : closing speed on the car ahead = v - v_lead (m/s, positive = approaching)
// s      : actual gap to the car ahead (m)
// params : { a, b, s0, T, delta } - see PARAM DEFAULTS below
export function idmAcceleration(v, v0, dv, s, params = IDM_DEFAULTS) {
    const { a, b, s0, T, delta } = params;
    const sStar = s0 + v * T + (v * dv) / (2 * Math.sqrt(a * b));
    return a * (1 - Math.pow(v / v0, delta) - Math.pow(sStar / s, 2));
}

// Treiber et al.'s commonly-used parameter set (see original paper §2 for
// discussion of typical ranges) - adjust here, not per-caller, if tuning.
export const IDM_DEFAULTS = {
    a: 1.4, // max acceleration, m/s^2
    b: 2.0, // comfortable braking deceleration, m/s^2
    s0: 2.0, // minimum gap at standstill, m
    T: 1.5, // desired time headway, s
    delta: 4, // acceleration exponent
};

// ---------------------------------------------------------------------
// Webster's method
// Webster, F. V., 1958. Traffic Signal Settings. Road Research Technical
// Paper No. 39. London: Road Research Laboratory, HMSO.
//
// Optimum cycle length:
//   Co = (1.5*L + 5) / (1 - Y)
// Green time per phase i:
//   gi = (yi / Y) * (C - L)
//
// L         : total lost time per cycle, s (sum of per-phase lost time)
// flowRatios: array of yi = qi/si for each phase (flow / saturation flow)
export function websterOptimumCycle(L, flowRatios) {
    const Y = flowRatios.reduce((sum, y) => sum + y, 0);
    if (Y >= 1) {
        throw new Error(
            `Webster's method undefined: Y = ${Y} >= 1 (oversaturated, ` +
                `intersection cannot clear demand at any cycle length)`
        );
    }
    return (1.5 * L + 5) / (1 - Y);
}

export function websterGreenSplit(cycleLength, L, flowRatios) {
    const Y = flowRatios.reduce((sum, y) => sum + y, 0);
    const effectiveGreen = cycleLength - L;
    return flowRatios.map((yi) => (yi / Y) * effectiveGreen);
}

// ---------------------------------------------------------------------
// Green wave / progression-band offset
// Roess, R. P., Prassas, E. S. & McShane, W. R., 2004. Traffic Engineering.
// 3rd ed. Upper Saddle River: Pearson Prentice Hall.
//
// Standard fixed-offset progression: the downstream signal turns green
// exactly as long as it takes a car travelling at the target progression
// speed to arrive from the upstream signal.
//
// distanceMeters   : distance between the two intersections, m
// targetSpeedMps   : target progression speed, m/s (not necessarily the
//                    posted speed limit - see corridor config)
export function greenWaveOffset(distanceMeters, targetSpeedMps) {
    return distanceMeters / targetSpeedMps;
}

// ---------------------------------------------------------------------
// Poisson vehicle arrivals
// Daganzo, C. F., 1997. Fundamentals of Transportation and Traffic
// Operations. Oxford: Pergamon.
//
// For a Poisson arrival process with rate lambda (vehicles/sec), the time
// until the next arrival is exponentially distributed. Sampled via inverse
// transform: t = -ln(U) / lambda, U ~ Uniform(0,1).
//
// IMPORTANT: `rng` must be the seeded PRNG instance (rng.js), never
// Math.random() directly - this is one of the calls that has to be seeded
// for batch-mode reproducibility.
export function nextPoissonArrival(lambdaPerSecond, rng) {
    const u = rng.next(); // uniform (0,1) from the seeded generator
    return -Math.log(u) / lambdaPerSecond;
}

// ---------------------------------------------------------------------
// Sensor-adaptive threshold/extension heuristic
//
// NOTE: unlike the four functions above, this is not a single named
// published equation - it is a rule mirroring the general sense->process
// ->execute ATSC loop and SCATS/SCOOT-style gap-extension logic (Lowrie,
// 1990; Hunt, et al., 1981), which describe the strategy but do not specify
// one universal formula. Documented here anyway so every threshold/cap value
// used is in the same reviewable place as the cited formulas, not buried in
// a controller file.
//
// secondsSinceLastDetection : time since a vehicle last actuated the green
//                             approach's stop-line detector (sensors.js's
//                             `detectPresenceAtStopLine()`) - NOT a queue
//                             count. A discharging queue keeps re-actuating
//                             the detector as each car rolls through, so this
//                             stays near zero for as long as vehicles keep
//                             arriving at the line, whether they're stopped
//                             or already moving.
// greenElapsed              : seconds the current phase has already been green
// params                    : { gapOutS, maxGreen, minGreen }
export function shouldExtendGreen(secondsSinceLastDetection, greenElapsed, params = ADAPTIVE_DEFAULTS) {
    const { gapOutS, maxGreen, minGreen } = params;
    if (greenElapsed < minGreen) return true;
    if (greenElapsed >= maxGreen) return false;
    return secondsSinceLastDetection < gapOutS;
}

/**
 * Is the waiting phase's queue big enough to be worth taking the green away
 * from whoever has it? Below this, a lone car (or a handful) on the minor
 * approach has to wait for a real call before it can cut off a much busier
 * phase - same "minimum call" idea as a vehicle-actuated controller's
 * detector logic, not just "any car at all counts."
 */
export function hasSufficientCall(waitingQueueLength, params = ADAPTIVE_DEFAULTS) {
    return waitingQueueLength >= params.minCallToSwitch;
}

export const ADAPTIVE_DEFAULTS = {
    gapOutS: 3, // seconds - end the phase once no vehicle has actuated the stop-line detector for this long
    minGreen: 8, // seconds - never cut a phase shorter than this
    maxGreen: 45, // seconds - hard cap regardless of queue
    minCallToSwitch: 5, // vehicles - the other phase needs at least this many queued before it's worth switching to (wide-window sensors only, see engine.js's _isOtherCallSufficient() - ignored once maxGreen is hit)
    callDebounceS: 3, // seconds - narrow-window sensors (inductive_loop, magnetometer) can't count queue depth, so instead the other phase's call must simply persist this long before it's worth switching to
};

// ---------------------------------------------------------------------
// Fluctuating corridor demand
//
// NOTE: like the adaptive threshold heuristic above, this is not a single
// cited formula - a real demand-over-time curve (e.g. the HCM's peak hour
// factor) is an empirical fit to a specific site, not a closed form. This is
// a documented, reproducible stand-in for "demand isn't constant all day":
// a sinusoid oscillating between a configured min and max over one period,
// sampled at whatever sim time a lane draws its next inter-arrival gap
// (engine.js's `_liveSpawnRate()`). At t=0 it equals the midpoint, which is
// deliberate - it's also the "design flow" `fixedTime.js`/`greenWave.js`
// time their one-off Webster plan to (recomputed only on an explicit
// setDemand() call, never automatically as the live rate below wanders away
// from it - see corridor.js's `buildDemand()`).
//
// tS      : sim time, seconds
// bounds  : { minPerLanePerMin, maxPerLanePerMin, periodS }
export function fluctuatingDemand(tS, bounds) {
    const { minPerLanePerMin, maxPerLanePerMin, periodS } = bounds;
    const mid = (minPerLanePerMin + maxPerLanePerMin) / 2;
    const amplitude = (maxPerLanePerMin - minPerLanePerMin) / 2;
    return mid + amplitude * Math.sin((2 * Math.PI * tS) / periodS);
}
