/**
 * runHeadless.js - build step 13.
 *
 * Same engine, no render: strips requestAnimationFrame and Canvas out of the
 * loop entirely and just steps `SimulationEngine` on a fixed timestep in a
 * plain `while` loop, so a batch of runs finishes in real compute time rather
 * than wall-clock animation time.
 *
 * Isomorphic on purpose - this file does no file I/O and touches no DOM, so
 * the exact same function runs both from the CLI batch driver
 * (`batch/runBatch.mjs`, Node) and from the `/results` page's batch-run
 * button (build step 17, browser). Only the caller differs in what it does
 * with the returned rows/summary.
 */
import { buildLayout } from './corridor.js';
import { ENTRY_BACKLOG_BALK_S, SimulationEngine, WAIT_ACCOUNTING, ZONE_ACCOUNTING } from './engine.js';
import { buildStages, controllerConfigFor, fixedTimeGreens, stageRatios } from './controllers/phasePlan.js';
import { sensorSpecHash } from './sensorSpecs.js';
import { SignalDiagnostics } from './metrics/signalDiagnostics.js';
import { ZoneFlow } from './metrics/zoneFlow.js';
import { hourPlanMultiplier, profileMultiplier } from './demandProfile.js';
import { avgWait, carsInDriveways, divertedPct, meanDrivewayWaitS, meanTripDelayS, meanTripS, throughputPerMin as perMin, zeroStopPct } from './metrics/definitions.js';

/** Row/perArterial id for the traffic on `scope: "arterial"` connectors, counted in the arterial scope. */
const ARTERIAL_CONNECTORS_ID = 'arterial_connectors';

/** The actuated modes - the ones whose runs read a sensor. */
const readsSensors = (controllerMode) => controllerMode === 'adaptive' || controllerMode === 'coordinated_adaptive' || controllerMode === 'adaptive_rich';

/**
 * @param seed                 integer PRNG seed
 * @param controllerMode       'fixed' | 'adaptive' | 'green_wave' | 'coordinated_adaptive' | 'adaptive_rich' - applied to every arterial in the corridor;
 *                             'adaptive_rich' is the adaptive controller under demandEstimator.js's richCallSufficient() (RQ2's richness test)
 * @param sensorMode           'none' | 'inductive_loop' | 'radar' | 'camera' | 'magnetometer'
 * @param warmupTicks          ticks run BEFORE anything is measured, discarded from every stat - the
 *                             standard traffic-sim warm-up: long enough for queue lengths/wait times to
 *                             leave their from-empty ramp-up transient under normal power, so the
 *                             outage and recovery windows below land inside an already-equilibrated
 *                             corridor instead of a still-filling one. Does not affect car conservation
 *                             (that check spans the whole run, warm-up included) - see engine.js's
 *                             resetStats(). 0 (the default) measures from t=0, same as before this existed.
 * @param powerOutageStartTick tick the outage begins at (relative to the END of warm-up, i.e. tick 0 of
 *                             the measured phase), or null for a normal-power run
 * @param powerOutageEndTick   tick power is restored at (same measured-phase-relative timing) - required
 *                             whenever `powerOutageStartTick` is set
 * @param rollingSchedule      a rolling blackout instead of a total one: [{ zones, fromTick, toTick }] (measured ticks,
 *                             batchSchedule.js's ROLLING_SCHEDULE) - each window's zones dark inside it. Leave the
 *                             outage ticks null with it; the outage then runs from the first window's start to the
 *                             last one's end (the segments' "during", the total/arterial/side recovery's restore)
 * @param corridorConfig       parsed corridor JSON (same shape `buildLayout()` already takes)
 * @param durationTicks        number of MEASURED ticks to run, after warm-up - `rows`/`sideStreetRows`
 *                             and every summary stat are scoped to this window only
 * @param dt                   physics timestep in seconds (must match the live sim's FIXED_DT_S for the sanity-check comparison in build step 13 to be meaningful)
 * @param sampleEverySeconds   how often (sim time) to emit a CSV row - spec explicitly says not literally every tick
 * @param routingMode          'random' | 'destination' - overrides the corridor's own `routing.mode` for this run;
 *                             null keeps the corridor's (random when it has no `routing` section)
 * @param websterTurnWeight    sensitivity runs only: Webster's protected-turn q scaled by the stage's weight
 * @param fixedFloorS          sensitivity runs only (plan step 14): fixed-time cycles never shorter than this many s (50 or 60); 0 = SARTSM 30 s
 * @param fixedTimeOfDay       sensitivity runs only (time-of-day plans): with a demandProfile, fixed-time signals are re-timed on the hour for that hour's demand (demandProfile.js's hourPlanMultiplier()); false = one peak plan all evening
 * @param adaptiveMaxGreen     sensitivity runs only (plan Phase 4 item 6): 'sartsm' caps plain adaptive's maxima to a 120 s cycle (phasePlan.js's sartsmMaxGreens()); 'default' = 45 s
 * @param entryBacklogBalkS    sensitivity runs only: s an arrival queues at a full entry before giving up; undefined = engine.js's ENTRY_BACKLOG_BALK_S
 * @param coordination         coordinated adaptive's overrides of equations.js's COORDINATED_DEFAULTS - e.g.
 *                             { platoonMessages: false, selfTuning: false } for the layer ablation
 * @param sensorSpecSet        sensorSpecs.js set: 'field' (the hardware models, default) or 'legacy' (the pre-overhaul sensors)
 * @param sensorErrors         sensitivity runs only: switch on the specs' miss / false-call / crosstalk / count-noise models
 * @param demandProfile        the long-outage protocol's time-of-day demand: { profile, startClockS } - demandProfile.js's
 *                             profile, and the clock time (s after midnight) at measured tick 0. The clock runs through
 *                             warm-up too, so warm-up ends at startClockS on the profile's demand. Null: flat demand
 * @returns { rows: object[], sideStreetRows: object[], totalRows: object[], summary: object } - `totalRows` is the
 *          total scope (every vehicle once); since a trip can use several scopes it isn't rows + sideStreetRows
 */
export function runHeadless({
    seed,
    controllerMode,
    sensorMode,
    warmupTicks = 0,
    powerOutageStartTick = null,
    powerOutageEndTick = null,
    rollingSchedule = null,
    corridorConfig,
    durationTicks,
    dt = 0.1,
    sampleEverySeconds = 1,
    routingMode = null,
    websterTurnWeight = false,
    fixedFloorS = 0,
    adaptiveMaxGreen = 'default',
    fixedTimeOfDay = false,
    entryBacklogBalkS = undefined,
    coordination = {},
    sensorSpecSet = undefined,
    sensorErrors = false,
    demandProfile = null,
}) {
    const layout = buildLayout(corridorConfig);
    const engine = new SimulationEngine(layout);

    const arterialModes = {};
    const demand = {};
    for (const arterial of layout.arterials) {
        arterialModes[arterial.id] = controllerMode === 'adaptive_rich' ? 'adaptive' : controllerMode;
        demand[arterial.id] = arterial.demand.spawnRatePerLanePerMin;
    }
    for (const connector of layout.connectors) {
        demand[connector.id] = connector.demand.spawnRatePerLanePerMin;
    }

    engine.reset({
        seed,
        arterialModes,
        demand,
        sensorMode,
        batteryBackedSensors: true,
        power: { loadShedding: false, scheduledOutages: false, offMinutes: 2, periodMinutes: 8 },
        routingMode,
        websterTurnWeight,
        fixedFloorS,
        adaptiveMaxGreen,
        entryBacklogBalkS,
        coordination,
        sensorSpecSet,
        sensorErrors,
        ...(controllerMode === 'adaptive_rich' ? { callRule: 'rich' } : {}),
    });

    /** Recorded on the run's config only - the re-timing itself happens in the tick loop below. */
    engine.fixedTimeOfDay = Boolean(fixedTimeOfDay && demandProfile);
    const sampleEveryTicks = Math.max(1, Math.round(sampleEverySeconds / dt));
    const rows = [];
    const sideStreetRows = [];
    const totalRows = [];
    const arterialScopeRows = [];
    /** Per sampled tick, one row per rolling-blackout zone - the zone scopes' segments and recovery. */
    const zoneRows = [];
    const schedule = outageSchedule({ powerOutageStartTick, powerOutageEndTick, rollingSchedule });
    let darkZonesKey = '';
    let stage = null;
    /** stage -> engine.roadWaits' running totals as that stage opened, so each road's wait splits by stage (clear time) - recording only. */
    const roadWaitMarks = new Map();
    let outageStarted = false;
    let outageEnded = false;
    let statsReset = false;
    let accountingAtMeasureStart = { ...engine.accounting };
    /** Fixed-time runs: each signal's Webster plan as the measured window opens (diagnostics.webster). */
    let websterAtStart = null;
    /** stage -> the delay counters as that stage opened, so the vehicle-hours split by stage (diagnostics.delay.byStage). */
    const delayMarks = new Map();
    const ticksPerSecond = Math.max(1, Math.round(1 / dt));

    const totalTicks = warmupTicks + durationTicks;
    for (let tick = 0; tick < totalTicks; tick += 1) {
        const measuredTick = tick - warmupTicks;
        if (demandProfile && tick % ticksPerSecond === 0) {
            engine.demandMultiplier = profileMultiplier(demandProfile.profile, demandProfile.startClockS + measuredTick * dt);
            if (fixedTimeOfDay) engine.setFixedPlanScale(hourPlanMultiplier(demandProfile.profile, demandProfile.startClockS + measuredTick * dt));
        }

        if (!statsReset && measuredTick >= 0) {
            if (warmupTicks > 0) engine.resetStats();
            statsReset = true;
            accountingAtMeasureStart = { ...engine.accounting };
            if (readsSensors(controllerMode)) engine.signalDiagnostics = new SignalDiagnostics();
            engine.zoneFlow = new ZoneFlow(engine.simTimeS);
            if (controllerMode === 'fixed') websterAtStart = websterPlans(engine);
        }

        if (powerOutageStartTick != null && !outageStarted && measuredTick >= powerOutageStartTick) {
            engine.setManualLoadShedding(true);
            outageStarted = true;
        }
        if (powerOutageEndTick != null && outageStarted && !outageEnded && measuredTick >= powerOutageEndTick) {
            engine.setManualLoadShedding(false);
            outageEnded = true;
        }
        // The coordination record's stage first, so a power return it triggers counts in the stage it opens.
        const stageNow = measuredTick >= 0 ? schedule?.stageAt(measuredTick) ?? null : null;
        if (stageNow !== stage) {
            engine.coordinationStats.setStage(stageNow);
            engine.signalDiagnostics?.setStage(stageNow);
            if (stageNow) {
                roadWaitMarks.set(stageNow, copyRoadWaits(engine.roadWaits));
                delayMarks.set(stageNow, delayCounters(engine));
            }
            stage = stageNow;
        }
        if (rollingSchedule && measuredTick >= 0) {
            const zones = rollingSchedule.filter((w) => measuredTick >= w.fromTick && measuredTick < w.toTick).flatMap((w) => w.zones);
            const key = [...new Set(zones)].sort().join(',');
            if (key !== darkZonesKey) {
                engine.setZoneDark(zones);
                darkZonesKey = key;
            }
        }

        engine.tick(dt);

        if (measuredTick >= 0 && measuredTick % sampleEveryTicks === 0) {
            const snap = engine.snapshot();
            for (const arterial of layout.arterials) {
                const s = snap.stats[arterial.id];
                const row = {
                    tick: measuredTick,
                    arterial: arterial.id,
                    avgWaitTime: round(s.avgWaitRolling, 3),
                    throughputPerMin: s.throughputPerMin,
                    clearedTotal: s.clearedTotal,
                    waitSumTotal: s.waitSumTotal,
                    clearedWithoutStopping: s.clearedWithoutStopPct == null ? '' : round(s.clearedWithoutStopPct, 1),
                    powerState: snap.powerState,
                };
                for (const info of engine.nodeInfosByArterial.get(arterial.id) ?? []) {
                    row[`queueLength_${info.node.id}`] = s.queues[info.node.id];
                }
                rows.push(row);
            }

            // A major road modelled as cross streets (connector `scope: "arterial"`) is one more arterial row.
            if (snap.arterialConnectors) {
                const s = snap.arterialConnectors;
                rows.push({
                    tick: measuredTick,
                    arterial: ARTERIAL_CONNECTORS_ID,
                    avgWaitTime: round(s.avgWaitRolling, 3),
                    throughputPerMin: s.throughputPerMin,
                    clearedTotal: s.clearedTotal,
                    waitSumTotal: s.waitSumTotal,
                    clearedWithoutStopping: s.clearedWithoutStopPct == null ? '' : round(s.clearedWithoutStopPct, 1),
                    powerState: snap.powerState,
                });
            }

            sideStreetRows.push({
                tick: measuredTick,
                avgWaitTime: round(snap.sideStreet.avgWaitRolling, 3),
                throughputPerMin: snap.sideStreet.throughputPerMin,
                clearedTotal: snap.sideStreet.clearedTotal,
                waitSumTotal: snap.sideStreet.waitSumTotal,
                clearedWithoutStopping:
                    snap.sideStreet.clearedWithoutStopPct == null ? '' : round(snap.sideStreet.clearedWithoutStopPct, 1),
                powerState: snap.powerState,
            });

            arterialScopeRows.push({
                tick: measuredTick,
                avgWaitTime: round(snap.arterialScope.avgWaitRolling, 3),
                throughputPerMin: snap.arterialScope.throughputPerMin,
                clearedTotal: snap.arterialScope.clearedTotal,
                waitSumTotal: snap.arterialScope.waitSumTotal,
                clearedWithoutStopping: snap.arterialScope.clearedWithoutStopPct == null ? '' : round(snap.arterialScope.clearedWithoutStopPct, 1),
                powerState: snap.powerState,
            });

            totalRows.push({
                tick: measuredTick,
                avgWaitTime: round(snap.total.avgWaitRolling, 3),
                throughputPerMin: snap.total.throughputPerMin,
                clearedTotal: snap.total.clearedTotal,
                waitSumTotal: snap.total.waitSumTotal,
                clearedWithoutStopping: snap.total.clearedWithoutStopPct == null ? '' : round(snap.total.clearedWithoutStopPct, 1),
                powerState: snap.powerState,
            });

            for (const [zone, s] of Object.entries(snap.zones)) {
                zoneRows.push({
                    tick: measuredTick,
                    zone: Number(zone),
                    avgWaitTime: round(s.avgWaitRolling, 3),
                    throughputPerMin: s.throughputPerMin,
                    clearedTotal: s.clearedTotal,
                    waitSumTotal: s.waitSumTotal,
                    clearedWithoutStopping: s.clearedWithoutStopPct == null ? '' : round(s.clearedWithoutStopPct, 1),
                    powerState: snap.powerState,
                });
            }
        }
    }

    const accounting = engine.carAccounting();
    const summary = buildSummary({
        layout,
        engine,
        seed,
        controllerMode,
        sensorMode,
        warmupTicks,
        powerOutageStartTick,
        powerOutageEndTick,
        schedule,
        rollingSchedule,
        corridorConfig,
        durationTicks,
        dt,
        rows,
        sideStreetRows,
        totalRows,
        arterialScopeRows,
        zoneRows,
        accounting,
        accountingAtMeasureStart,
        roadWaitMarks,
        websterAtStart,
        delayMarks,
        demandProfile,
    });

    return { rows, sideStreetRows, totalRows, arterialScopeRows, zoneRows, summary };
}

/**
 * The run's outage as the summary measures it, or null at normal power: its start and FINAL restore tick (the
 * total/arterial/side segments and recovery), its dark windows, and the stage each measured tick falls in - a total
 * blackout's pre / during / post, a rolling blackout's pre / stage1 / stage2 / post.
 */
function outageSchedule({ powerOutageStartTick, powerOutageEndTick, rollingSchedule }) {
    if (rollingSchedule?.length) {
        const windows = [...rollingSchedule].sort((a, b) => a.fromTick - b.fromTick);
        const startTick = windows[0].fromTick;
        const endTick = Math.max(...windows.map((w) => w.toTick));
        return {
            powerState: 'rolling_blackout',
            startTick,
            endTick,
            windows,
            stageAt: (tick) => {
                if (tick < startTick) return 'pre';
                if (tick >= endTick) return 'post';
                const index = windows.findIndex((w) => tick >= w.fromTick && tick < w.toTick);
                return index < 0 ? 'post' : `stage${index + 1}`;
            },
        };
    }
    if (powerOutageStartTick == null || powerOutageEndTick == null) return null;
    return {
        powerState: 'load_shedding',
        startTick: powerOutageStartTick,
        endTick: powerOutageEndTick,
        windows: [{ zones: null, fromTick: powerOutageStartTick, toTick: powerOutageEndTick }],
        stageAt: (tick) => (tick < powerOutageStartTick ? 'pre' : tick < powerOutageEndTick ? 'during' : 'post'),
    };
}

function copyRoadWaits(roadWaits) {
    return new Map([...roadWaits].map(([id, r]) => [id, { n: r.n, waitSum: r.waitSum }]));
}

/**
 * Each road's waits split by outage stage, by when its vehicles cleared - the difference of the running totals at
 * consecutive stage marks: { pre: { vehicles, meanWait }, stage1: ..., post: ... }. Stages with no vehicle are left out.
 */
function roadWaitStages(roadId, final, marks) {
    const stages = [...marks.keys()];
    const out = {};
    stages.forEach((stage, i) => {
        const from = marks.get(stage).get(roadId) ?? { n: 0, waitSum: 0 };
        const to = i + 1 < stages.length ? marks.get(stages[i + 1]).get(roadId) ?? { n: 0, waitSum: 0 } : final;
        const n = to.n - from.n;
        if (n > 0) out[stage] = { vehicles: n, meanWait: Math.round(((to.waitSum - from.waitSum) / n) * 100) / 100 };
    });
    return out;
}

/** `engine.roadWaits` as plain JSON, named and scoped from the layout: { roadId: { name, scope, vehicles, meanWait, maxWait, stages? } }. */
function roadWaitsSummary(layout, roadWaits, stageMarks = null) {
    const roads = new Map();
    for (const arterial of layout.arterials) roads.set(arterial.id, { name: arterial.name, scope: arterial.scope === 'side' ? 'side' : 'arterial' });
    for (const connector of layout.connectors) roads.set(connector.id, { name: connector.name ?? connector.id, scope: connector.scope === 'arterial' ? 'arterial' : 'side' });
    const round = (value) => Math.round(value * 100) / 100;
    return Object.fromEntries(
        [...roadWaits]
            .filter(([id]) => roads.has(id))
            .map(([id, r]) => [
                id,
                {
                    ...roads.get(id),
                    vehicles: r.n,
                    meanWait: round(r.waitSum / r.n),
                    maxWait: round(r.maxWait),
                    ...(stageMarks?.size ? { stages: roadWaitStages(id, r, stageMarks) } : {}),
                },
            ])
    );
}

function buildSummary({
    layout,
    engine,
    seed,
    controllerMode,
    sensorMode,
    warmupTicks,
    powerOutageStartTick: outageStartArg,
    powerOutageEndTick: outageEndArg,
    schedule,
    rollingSchedule,
    corridorConfig,
    durationTicks,
    dt,
    rows,
    sideStreetRows,
    totalRows,
    arterialScopeRows,
    zoneRows,
    accounting,
    accountingAtMeasureStart,
    roadWaitMarks,
    websterAtStart,
    delayMarks,
    demandProfile,
}) {
    // A rolling blackout's outage runs from its first window's start to its final restore - every scope below that
    // isn't a zone is measured on that span, exactly as a total blackout's.
    const powerOutageStartTick = schedule?.startTick ?? null;
    const powerOutageEndTick = schedule?.endTick ?? null;
    const finalSnap = engine.snapshot();
    const durationSeconds = durationTicks * dt;

    // Full-run average wait/throughput per arterial: a true whole-run rate computed from
    // cumulative counters, NOT `avgWaitRolling`/`throughputPerMin`'s last-60-simulated-second
    // rolling snapshot. That rolling window sits entirely inside the post-outage tail for a
    // load-shedding run, which structurally erases most of the run's real signal-vs-fixed-time
    // difference - see the Phase 2 results-page audit.
    const arterialBuckets = [
        ...layout.arterials.map((arterial) => ({ id: arterial.id, s: finalSnap.stats[arterial.id] })),
        ...(finalSnap.arterialConnectors ? [{ id: ARTERIAL_CONNECTORS_ID, s: finalSnap.arterialConnectors }] : []),
    ];
    const perArterial = arterialBuckets.map(({ id, s }) => {
        return {
            id,
            avgWaitTime: avgWait(s.waitSumTotal, s.clearedTotal),
            throughputPerMin: perMin(s.clearedTotal, durationSeconds),
            clearedTotal: s.clearedTotal,
            waitSumTotal: s.waitSumTotal,
            clearedWithoutStopTotal: s.clearedWithoutStopTotal,
            pctClearedWithoutStop: s.clearedWithoutStopPct,
        };
    });

    // Arterial scope: aggregated across arterials to match `simulation_runs`'
    // single-scalar-per-run schema (build step 16). Throughput is additive
    // (sum across arterials); wait time and cleared-without-stop % are
    // weighted by each arterial's own cleared count so a busier arterial
    // counts for more, not an unweighted average of two possibly very
    // different sample sizes.
    // The engine's arterial-scope bucket: a trip along two arterials is one vehicle, not two.
    const arterialScope = finalSnap.arterialScope;
    const clearedTotalArterial = arterialScope.clearedTotal;
    const waitSumTotalArterial = arterialScope.waitSumTotal;
    const clearedWithoutStopTotalArterial = arterialScope.clearedWithoutStopTotal;
    const throughputPerMinArterial = perMin(clearedTotalArterial, durationSeconds);
    const avgWaitTimeArterial = avgWait(waitSumTotalArterial, clearedTotalArterial);
    const pctClearedWithoutStopArterial = zeroStopPct(clearedWithoutStopTotalArterial, clearedTotalArterial);

    // Side-street scope: the engine already keeps one combined bucket across
    // every connector (see engine.js's `sideStreetStats`), so no further
    // aggregation is needed here.
    const sideStreet = finalSnap.sideStreet;
    const avgWaitTimeSideStreet = avgWait(sideStreet.waitSumTotal, sideStreet.clearedTotal);
    const throughputPerMinSideStreet = perMin(sideStreet.clearedTotal, durationSeconds);

    // Total scope: the engine's own every-vehicle-once bucket - not arterial + side street, since
    // a trip can use both and is counted in each it used (engine.js's WAIT_ACCOUNTING).
    const total = finalSnap.total;
    const clearedTotal = total.clearedTotal;
    const waitSumTotal = total.waitSumTotal;
    const clearedWithoutStopTotal = total.clearedWithoutStopTotal;
    const throughputPerMin = perMin(clearedTotal, durationSeconds);
    const avgWaitTime = avgWait(waitSumTotal, clearedTotal);
    const pctClearedWithoutStop = zeroStopPct(clearedWithoutStopTotal, clearedTotal);

    const totalCumulativeByTick = buildCumulativeByTick(totalRows);
    const arterialCumulativeByTick = buildCumulativeByTick(arterialScopeRows);
    const sideStreetCumulativeByTick = buildCumulativeByTick(sideStreetRows);
    const arterialByTick = buildByTickThroughput(arterialScopeRows);
    const sideStreetByTick = buildByTickThroughput(sideStreetRows);
    const totalByTick = buildByTickThroughput(totalRows);

    const arterialWaitByTick = buildByTickWeightedAvgWait([arterialScopeRows]);
    const sideStreetWaitByTick = buildByTickWeightedAvgWait([sideStreetRows]);
    const totalWaitByTick = buildByTickWeightedAvgWait([totalRows]);

    // Pre-outage / during-outage / post-recovery segmented total-scope averages - only
    // meaningful (non-null) for a bounded-outage run. Computed from cumulative counters at
    // the segment boundaries, not from the rolling window, for the same reason as the
    // full-run averages above; this is the only way to see the real, undiluted Adaptive-vs-
    // Fixed-time gap on either side of the outage.
    const segments =
        powerOutageStartTick != null && powerOutageEndTick != null
            ? {
                  preOutage: segmentStats(totalCumulativeByTick, 0, powerOutageStartTick, dt),
                  duringOutage: segmentStats(totalCumulativeByTick, powerOutageStartTick, powerOutageEndTick, dt),
                  postRecovery: segmentStats(
                      totalCumulativeByTick,
                      powerOutageEndTick,
                      durationTicks,
                      dt,
                      { clearedTotal, waitSumTotal }
                  ),
                  preOutageArterial: segmentStats(arterialCumulativeByTick, 0, powerOutageStartTick, dt),
                  duringOutageArterial: segmentStats(arterialCumulativeByTick, powerOutageStartTick, powerOutageEndTick, dt),
                  postRecoveryArterial: segmentStats(
                      arterialCumulativeByTick,
                      powerOutageEndTick,
                      durationTicks,
                      dt,
                      { clearedTotal: clearedTotalArterial, waitSumTotal: waitSumTotalArterial }
                  ),
                  preOutageSideStreet: segmentStats(sideStreetCumulativeByTick, 0, powerOutageStartTick, dt),
                  duringOutageSideStreet: segmentStats(sideStreetCumulativeByTick, powerOutageStartTick, powerOutageEndTick, dt),
                  postRecoverySideStreet: segmentStats(
                      sideStreetCumulativeByTick,
                      powerOutageEndTick,
                      durationTicks,
                      dt,
                      { clearedTotal: sideStreet.clearedTotal, waitSumTotal: sideStreet.waitSumTotal }
                  ),
              }
            : {
                  preOutage: null, duringOutage: null, postRecovery: null,
                  preOutageArterial: null, duringOutageArterial: null, postRecoveryArterial: null,
                  preOutageSideStreet: null, duringOutageSideStreet: null, postRecoverySideStreet: null,
              };

    const waitDistribution = engine.waitDistributionTotal();
    const arterialWaits = engine.waitDistribution('arterial');
    const sideStreetWaits = engine.waitDistribution('sideStreet');

    // A rolling blackout's two stages, per scope - the total/arterial/side columns' stage 1 / stage 2 split of "during".
    const stageWindows = schedule?.powerState === 'rolling_blackout' ? schedule.windows : [];
    const stages = {};
    stageWindows.forEach((w, i) => {
        stages[`stage${i + 1}`] = segmentStats(totalCumulativeByTick, w.fromTick, w.toTick, dt);
        stages[`stage${i + 1}Arterial`] = segmentStats(arterialCumulativeByTick, w.fromTick, w.toTick, dt);
        stages[`stage${i + 1}SideStreet`] = segmentStats(sideStreetCumulativeByTick, w.fromTick, w.toTick, dt);
    });

    return {
        seed,
        controllerMode,
        routingMode: engine.routingMode,
        /** Destination routing's trip counters over the measured window - null for a random-turning run. */
        routing: engine.routingActive ? routingSummary(engine.routingStats, engine.departures, engine.simTimeS) : null,
        diagnostics: {
            ...measuredDiagnostics(engine, accountingAtMeasureStart),
            delay: delaySummary(engine, accountingAtMeasureStart, accounting, delayMarks),
            signals: engine.signalDiagnostics?.report() ?? null,
            zoneFlow: engine.zoneFlow?.report() ?? null,
            webster: websterAtStart,
            // Threshold-sensitivity data for wait recovery (dissertation plan step 2) - stored in the diagnostics column.
            recoveryWait: recoveryWaitSweep({ total: totalWaitByTick, arterial: arterialWaitByTick, sideStreet: sideStreetWaitByTick }, powerOutageStartTick, powerOutageEndTick, durationTicks, dt),
            waitSeries: binnedWaitSeries({ total: totalWaitByTick, arterial: arterialWaitByTick, sideStreet: sideStreetWaitByTick }, dt),
        },
        powerState: schedule?.powerState ?? 'normal',
        sensorMode: controllerMode === 'fixed' ? null : sensorMode, // fixed-time never reads sensors (spec's DB schema note)
        /** Which sensor configuration produced the run (sensorSpecs.js) - null for the controllers that read no sensors. */
        sensorSpec: readsSensors(controllerMode)
            ? { set: engine.sensorSpecSet, hash: sensorSpecHash(engine.sensorSpec, engine.sensorErrorsOn), errorsOn: engine.sensorErrorsOn }
            : null,
        corridorConfig: corridorConfig.id,
        avgWaitTime,
        avgWaitTimeArterial,
        avgWaitTimeSideStreet,
        throughputPerMin,
        throughputPerMinArterial,
        throughputPerMinSideStreet,
        pctClearedWithoutStop,
        pctClearedWithoutStopArterial,
        pctClearedWithoutStopSideStreet: sideStreet.clearedWithoutStopPct,
        medianWait: waitDistribution.medianWait,
        p95Wait: waitDistribution.p95Wait,
        maxWait: waitDistribution.maxWait,
        p95WaitArterial: arterialWaits.p95Wait,
        maxWaitArterial: arterialWaits.maxWait,
        p95WaitSideStreet: sideStreetWaits.p95Wait,
        maxWaitSideStreet: sideStreetWaits.maxWait,
        /** Per road: vehicles that used it, their mean and worst wait built up on it - the report's per-road table. */
        roadWaits: roadWaitsSummary(layout, engine.roadWaits, roadWaitMarks),
        // What the coordination did (controllers/coordinationStats.js) - coordinated adaptive runs only.
        ...(controllerMode === 'coordinated_adaptive' ? { coordination: coordinationSummary(engine, warmupTicks * dt) } : {}),
        preOutage: segments.preOutage,
        duringOutage: segments.duringOutage,
        postRecovery: segments.postRecovery,
        preOutageArterial: segments.preOutageArterial,
        duringOutageArterial: segments.duringOutageArterial,
        postRecoveryArterial: segments.postRecoveryArterial,
        preOutageSideStreet: segments.preOutageSideStreet,
        duringOutageSideStreet: segments.duringOutageSideStreet,
        postRecoverySideStreet: segments.postRecoverySideStreet,
        timeToRecoverySeconds: computeRecoverySeconds(totalByTick, powerOutageStartTick, powerOutageEndTick, dt),
        timeToRecoverySecondsArterial: computeRecoverySeconds(arterialByTick, powerOutageStartTick, powerOutageEndTick, dt),
        timeToRecoverySecondsSideStreet: computeRecoverySeconds(sideStreetByTick, powerOutageStartTick, powerOutageEndTick, dt),
        // Wait-time's own recovery time: "lower is better", so recovered means DROPPING back to
        // (rather than climbing up to) within tolerance of the pre-outage baseline. 1.25x
        // mirrors throughput's 0.8x (1 / 0.8 = 1.25) - no data-driven reason to pick a different
        // tolerance for a metric moving in the opposite direction.
        timeToRecoveryWaitSeconds: computeRecoverySeconds(totalWaitByTick, powerOutageStartTick, powerOutageEndTick, dt, {
            thresholdMultiplier: 1.25,
            notRecoveredWhen: (value, threshold) => value > threshold,
        }),
        timeToRecoveryWaitSecondsArterial: computeRecoverySeconds(arterialWaitByTick, powerOutageStartTick, powerOutageEndTick, dt, {
            thresholdMultiplier: 1.25,
            notRecoveredWhen: (value, threshold) => value > threshold,
        }),
        timeToRecoveryWaitSecondsSideStreet: computeRecoverySeconds(sideStreetWaitByTick, powerOutageStartTick, powerOutageEndTick, dt, {
            thresholdMultiplier: 1.25,
            notRecoveredWhen: (value, threshold) => value > threshold,
        }),
        powerOutageStartSeconds: powerOutageStartTick != null ? round(powerOutageStartTick * dt, 1) : null,
        powerOutageEndSeconds: powerOutageEndTick != null ? round(powerOutageEndTick * dt, 1) : null,
        // Rolling blackout only: each stage's segments (stage1, stage1Arterial, stage1SideStreet, stage2...).
        ...stages,
        /** The dark windows, in measured seconds: [{ zones (null = every junction), fromS, toS }] - the charts' bands. Null at normal power. */
        darkWindows: schedule ? schedule.windows.map((w) => ({ zones: w.zones, fromS: round(w.fromTick * dt, 1), toS: round(w.toTick * dt, 1) })) : null,
        /** Per rolling-blackout zone (null on a layout without zones): its junctions' vehicles, each with the wait charged there. */
        zoneStats: zoneSummary({ engine, finalSnap, zoneRows, schedule, durationTicks, durationSeconds, dt }),
        perArterial,
        carAccounting: accounting,
        durationTicks,
        rawConfig: {
            seed,
            controllerMode,
            sensorMode,
            sensorSpecSet: engine.sensorSpecSet,
            sensorErrors: engine.sensorErrors,
            ...(engine.callRule !== 'presence' ? { callRule: engine.callRule } : {}),
            ...(engine.entryBacklogBalkS !== ENTRY_BACKLOG_BALK_S ? { entryBacklogBalkS: engine.entryBacklogBalkS } : {}),
            warmupTicks,
            powerOutageStartTick: outageStartArg,
            powerOutageEndTick: outageEndArg,
            /** A rolling blackout's windows, in measured ticks - what a replay drives setZoneDark() from. */
            ...(rollingSchedule ? { rollingSchedule } : {}),
            corridorConfig: corridorConfig.id,
            durationTicks,
            dt,
            routingMode: engine.routingMode,
            waitAccounting: WAIT_ACCOUNTING,
            ...(engine.zones.length ? { zoneAccounting: ZONE_ACCOUNTING } : {}),
            controllerConfig: {
                ...controllerConfigFor({ websterTurnWeight: engine.websterTurnWeight, fixedFloorS: engine.fixedFloorS, adaptiveMaxGreen: engine.adaptiveMaxGreen, fixedTimeOfDay: engine.fixedTimeOfDay }),
                // Which coordination layers ran (and their thresholds) - so an ablation run never reads as the full mode.
                ...(controllerMode === 'coordinated_adaptive' ? { coordination: { ...engine.coordination } } : {}),
            },
            /** Which destination tiers the corridor carried (routing.blocks) - null without a routing section. */
            routingTiersHash: tiersHash(layout.routing),
            /** Sensitivity-sweep settings (batch/runBatch.mjs) - 1 and null on an ordinary batch. */
            demandScale: corridorConfig.demandScale ?? 1,
            endToEndShare: layout.routing?.endToEndShare ?? null,
            /** The long-outage protocol's time-of-day demand (demandProfile.js) - absent on a flat-demand run. */
            ...(demandProfile ? { demandProfile: { id: demandProfile.profile.id, startClockS: demandProfile.startClockS, peakPct: demandProfile.profile.peakPct, hourPct: demandProfile.profile.hourPct } } : {}),
        },
    };
}

/** The coordination record, its power returns' times in measured seconds (the engine's clock counts warm-up too). */
function coordinationSummary(engine, warmupSeconds) {
    const summary = engine.coordinationStats.summary();
    if (summary.restores) summary.restores = summary.restores.map((r) => ({ ...r, atS: round(r.atS - warmupSeconds, 1) }));
    return summary;
}

/**
 * Each zone's scope, keyed zone1..zone3: its full-run figures, its segments (a total blackout's pre / during / post, a
 * rolling blackout's pre / stage1 / stage2 / during / post - post always from the final restore), and its recovery,
 * measured from ITS OWN restore against the pre-outage baseline. A rolling blackout's zones 1 and 3 come back while
 * zone 2 is still dark next to them, so theirs includes zone 2's spillback - not comparable to a total blackout's.
 */
function zoneSummary({ engine, finalSnap, zoneRows, schedule, durationTicks, durationSeconds, dt }) {
    if (!engine.zones.length) return null;
    const waitRecovery = { thresholdMultiplier: 1.25, notRecoveredWhen: (value, threshold) => value > threshold };
    const out = {};
    for (const zone of engine.zones) {
        const s = finalSnap.zones[zone];
        const rows = zoneRows.filter((row) => row.zone === zone);
        const cumulative = buildCumulativeByTick(rows);
        const final = { clearedTotal: s.clearedTotal, waitSumTotal: s.waitSumTotal };
        const distribution = engine.waitDistribution(`zone${zone}`);
        // Its own restore: the end of the last window that darkened it (every window, for a total blackout).
        const own = schedule ? schedule.windows.filter((w) => w.zones == null || w.zones.includes(zone)) : [];
        const restoreTick = own.length ? Math.max(...own.map((w) => w.toTick)) : null;
        let segments = null;
        if (schedule) {
            segments = {
                pre: segmentStats(cumulative, 0, schedule.startTick, dt),
                during: segmentStats(cumulative, schedule.startTick, schedule.endTick, dt),
                post: segmentStats(cumulative, schedule.endTick, durationTicks, dt, final),
            };
            if (schedule.powerState === 'rolling_blackout') {
                schedule.windows.forEach((w, i) => {
                    segments[`stage${i + 1}`] = segmentStats(cumulative, w.fromTick, w.toTick, dt);
                });
            }
        }
        out[`zone${zone}`] = {
            avgWaitTime: avgWait(s.waitSumTotal, s.clearedTotal),
            medianWait: distribution.medianWait,
            p95Wait: distribution.p95Wait,
            maxWait: distribution.maxWait,
            throughputPerMin: perMin(s.clearedTotal, durationSeconds),
            clearedTotal: s.clearedTotal,
            pctClearedWithoutStop: s.clearedWithoutStopPct,
            segments,
            restoreSeconds: restoreTick != null ? round(restoreTick * dt, 1) : null,
            /** The window its recovery is measured in, and capped at: its own restore to the end of the run. */
            postRestoreWindowS: restoreTick != null ? round((durationTicks - restoreTick) * dt, 1) : null,
            timeToRecoverySeconds: restoreTick != null ? computeRecoverySeconds(buildByTickThroughput(rows), schedule.startTick, restoreTick, dt) : null,
            timeToRecoveryWaitSeconds: restoreTick != null ? computeRecoverySeconds(buildByTickWeightedAvgWait([rows]), schedule.startTick, restoreTick, dt, waitRecovery) : null,
        };
    }
    return out;
}

/** Short FNV-1a hash of every block's id and tier, so two batches with edited tiers read as different. */
function tiersHash(routing) {
    if (!routing) return null;
    const text = routing.blocks.map((block) => `${block.id}:${block.tier}:${block.weightShare}`).join('|');
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Over the measured window: arrivals that found their map-edge entry full and queued outside it first (the entry backlog,
 * engine.js's _admitArrival() - `arrivalsLost`, the demand dropped before it existed, stays 0 since), and cars that left
 * the network while a roundabout still counted them as on its ring (the overrun _updateRoundaboutReleases() prevents -
 * should stay 0).
 */
function measuredDiagnostics(engine, atMeasureStart) {
    return {
        arrivalsLost: Math.round(engine.accounting.arrivalsLost - atMeasureStart.arrivalsLost),
        arrivalsQueued: engine.accounting.arrivalsQueued - atMeasureStart.arrivalsQueued,
        /** Of those, the ones that queued engine.js's ENTRY_BACKLOG_BALK_S and gave up - trips cancelled or taken elsewhere. */
        arrivalsBalked: engine.accounting.arrivalsBalked - atMeasureStart.arrivalsBalked,
        roundaboutOverruns: engine.accounting.roundaboutOverruns - atMeasureStart.roundaboutOverruns,
        lockup: engine.lockupWatch.report(),
    };
}

/** The engine's running delay counters - what diagnostics.delay and its stage split are differences of. */
function delayCounters(engine) {
    const { waitAccruedS, backlogWaitS, arrivalsQueued, arrivalsBalked } = engine.accounting;
    return { waitAccruedS, backlogWaitS, arrivalsQueued, arrivalsBalked };
}

/**
 * Total delay over the measured window in vehicle-hours (dissertation plan step 7.4): every second any vehicle stood
 * (engine.js's _addWait(), the same stop rule as the wait metric) - those still in the network at the end included,
 * where the mean wait counts only vehicles that cleared - plus every second an arrival queued outside a full entry
 * (the entry backlog), those still outside at the end included.
 */
function delaySummary(engine, atMeasureStart, accounting, delayMarks = new Map()) {
    const waitH = (engine.accounting.waitAccruedS - atMeasureStart.waitAccruedS) / 3600;
    const backlogH = (engine.accounting.backlogWaitS - atMeasureStart.backlogWaitS) / 3600;
    return {
        totalVehH: round(waitH + backlogH, 2),
        onNetworkVehH: round(waitH, 2),
        entryBacklogVehH: round(backlogH, 2),
        inNetworkAtEnd: accounting.onRoadNetwork,
        inEntryBacklogAtEnd: engine.entryBacklogCount(),
        ...(delayMarks.size ? { byStage: delayByStage(engine, delayMarks) } : {}),
    };
}

/**
 * The delay split by outage stage (pre / during or stage1, stage2 / post): the vehicle-hours stood on the network and
 * queued outside the entries while the stage was open, and the arrivals that had to queue - outage runs only.
 */
function delayByStage(engine, delayMarks) {
    const stages = [...delayMarks.keys()];
    const final = delayCounters(engine);
    return Object.fromEntries(
        stages.map((stage, i) => {
            const from = delayMarks.get(stage);
            const to = i + 1 < stages.length ? delayMarks.get(stages[i + 1]) : final;
            return [
                stage,
                {
                    onNetworkVehH: round((to.waitAccruedS - from.waitAccruedS) / 3600, 2),
                    entryBacklogVehH: round((to.backlogWaitS - from.backlogWaitS) / 3600, 2),
                    arrivalsQueued: to.arrivalsQueued - from.arrivalsQueued,
                    arrivalsBalked: to.arrivalsBalked - from.arrivalsBalked,
                },
            ];
        })
    );
}

/**
 * Each fixed-time signal's Webster plan as run (phasePlan.js's fixedTimeGreens() on the same inputs): Y (the stages'
 * summed flow ratios), the cycle, and per stage y, green and the degree of saturation x = yC/g - the demand
 * plausibility check (dissertation plan step 5). `oversaturated` where Y >= 1 and the fallback plan ran.
 */
function websterPlans(engine) {
    const plans = [];
    for (const info of engine.nodesInfo.values()) {
        if (info.controllerType !== 'fixed') continue;
        const arterialDemand = engine._arterialDemandAt(info.node);
        const crossDemand = engine._crossDemandFor(info.node);
        const turn = engine._turnStagesAt(info);
        const stages = buildStages(turn);
        const ratios = stageRatios(stages, arterialDemand, crossDemand, turn);
        const { greens, cycleLengthS } = fixedTimeGreens(stages, arterialDemand, crossDemand, turn, engine.fixedFloorS);
        const Y = ratios.reduce((sum, y) => sum + y, 0);
        plans.push({
            nodeId: info.node.id,
            Y: round(Y, 3),
            cycleS: round(cycleLengthS, 1),
            oversaturated: Y >= 1,
            stages: stages.map((stage, i) => ({
                phase: stage.phase,
                turn: stage.turn,
                y: round(ratios[i], 3),
                greenS: round(greens[i], 1),
                x: greens[i] > 0 ? round((ratios[i] * cycleLengthS) / greens[i], 3) : null,
            })),
        });
    }
    return plans;
}

/** Wait-recovery tolerances the sweep reports, as multiples of the pre-outage baseline - 1.25 is the summary's own. */
export const RECOVERY_WAIT_THRESHOLDS = [1.1, 1.25, 1.5];

/**
 * Wait recovery at every RECOVERY_WAIT_THRESHOLDS tolerance, per scope, by the same rule as timeToRecoveryWaitSeconds.
 * `censorAtS` is the post-restore window: a null time means "not recovered by then" (right-censored there), which is
 * what a Kaplan-Meier or restricted-mean analysis needs. Null at normal power.
 */
function recoveryWaitSweep(waitByTickByScope, powerOutageStartTick, powerOutageEndTick, durationTicks, dt) {
    if (powerOutageStartTick == null || powerOutageEndTick == null) return null;
    const recoveryAt = (byTick, thresholdMultiplier) =>
        computeRecoverySeconds(byTick, powerOutageStartTick, powerOutageEndTick, dt, {
            thresholdMultiplier,
            notRecoveredWhen: (value, threshold) => value > threshold,
        });
    return {
        thresholds: RECOVERY_WAIT_THRESHOLDS,
        censorAtS: round((durationTicks - powerOutageEndTick) * dt, 1),
        ...Object.fromEntries(Object.entries(waitByTickByScope).map(([scope, byTick]) => [
            scope,
            Object.fromEntries(RECOVERY_WAIT_THRESHOLDS.map((m) => [String(m), recoveryAt(byTick, m)])),
        ])),
    };
}

const WAIT_SERIES_BIN_SECONDS = 60;

/** Each scope's sampled mean wait averaged into WAIT_SERIES_BIN_SECONDS bins from the measured start - for offline re-analysis of recovery. */
function binnedWaitSeries(waitByTickByScope, dt) {
    const binTicks = WAIT_SERIES_BIN_SECONDS / dt;
    const bin = (byTick) => {
        const sums = [];
        const counts = [];
        for (const [tick, value] of byTick) {
            const i = Math.floor(tick / binTicks);
            sums[i] = (sums[i] ?? 0) + value;
            counts[i] = (counts[i] ?? 0) + 1;
        }
        return Array.from(sums, (sum, i) => (counts[i] ? round(sum / counts[i], 2) : null));
    };
    return {
        binS: WAIT_SERIES_BIN_SECONDS,
        ...Object.fromEntries(Object.entries(waitByTickByScope).map(([scope, byTick]) => [scope, bin(byTick)])),
    };
}

function routingSummary(stats, departures, nowS) {
    return {
        trips: stats.trips,
        meanTripS: meanTripS(stats),
        meanTripDelayS: meanTripDelayS(stats),
        toExit: stats.toExit,
        pulledOff: stats.pulledOff,
        divertedPct: divertedPct(stats),
        missedTurns: stats.missedTurns,
        missedBy: stats.missedBy,
        rerouted: stats.rerouted,
        pulledOffByBlock: stats.pulledOffByBlock,
        missedDriveways: stats.missedDriveways,
        missedDrivewaysBy: stats.missedDrivewaysBy,
        drivewayFallbacks: stats.drivewayFallbacks,
        pulledOffByDriveway: stats.pulledOffByDriveway,
        departed: stats.departed,
        departedByDriveway: stats.departedByDriveway,
        /** Cars still waiting in a driveway to pull out when the run ended - a road too busy to leave onto shows up here. */
        departuresWaiting: carsInDriveways(departures),
        /** Mean time a car that pulled out had waited in its driveway first - in neither its trip nor any wait metric. */
        meanDrivewayWaitS: meanDrivewayWaitS(stats),
        /** Longest any car still in a driveway at the end had been waiting there. */
        longestDrivewayWaitS: Math.max(0, ...departures.map((d) => (d.waiting.length ? nowS - d.waiting[0].queuedAtS : 0))),
        departuresWaitingByDriveway: Object.fromEntries(departures.filter((d) => d.waiting.length).map((d) => [d.origin.dirId, d.waiting.length])),
    };
}

export function buildByTickThroughput(rows) {
    const byTick = new Map();
    for (const row of rows) {
        byTick.set(row.tick, (byTick.get(row.tick) ?? 0) + row.throughputPerMin);
    }
    return byTick;
}

/**
 * Per-tick average wait across one or more row groups (e.g. every arterial, or arterial +
 * side-street combined), weighted by each row's own `throughputPerMin` - which, per
 * engine.js's snapshot(), is exactly `recentClears.length`, the same 60s-window car count
 * `avgWaitTime` was itself averaged over. Wait isn't additive like throughput, so a plain
 * sum/mean across arterials would let a near-empty arterial's noisy average count as much as
 * a busy one's; weighting by recent clears fixes that without needing new engine fields.
 */
export function buildByTickWeightedAvgWait(rowGroups) {
    const acc = new Map();
    for (const rows of rowGroups) {
        for (const row of rows) {
            const weight = row.throughputPerMin;
            const entry = acc.get(row.tick) ?? { weightedSum: 0, weightSum: 0 };
            entry.weightedSum += row.avgWaitTime * weight;
            entry.weightSum += weight;
            acc.set(row.tick, entry);
        }
    }

    const byTick = new Map();
    for (const [tick, { weightedSum, weightSum }] of acc) {
        byTick.set(tick, weightSum > 0 ? weightedSum / weightSum : 0);
    }
    return byTick;
}

/** Cumulative {clearedTotal, waitSumTotal} at every sampled tick, summed across one row group. */
function buildCumulativeByTick(rows) {
    const byTick = new Map();
    for (const row of rows) {
        const entry = byTick.get(row.tick) ?? { clearedTotal: 0, waitSumTotal: 0 };
        entry.clearedTotal += row.clearedTotal;
        entry.waitSumTotal += row.waitSumTotal;
        byTick.set(row.tick, entry);
    }
    return byTick;
}

/** Cumulative {clearedTotal, waitSumTotal} as of the latest sampled tick at or before `tick`, or zero before the first sample. */
function cumulativeAtOrBefore(cumulativeByTick, tick) {
    if (tick <= 0) return { clearedTotal: 0, waitSumTotal: 0 };

    let best = null;
    for (const [t, entry] of cumulativeByTick) {
        if (t <= tick && (best === null || t > best.t)) best = { t, entry };
    }
    return best ? best.entry : { clearedTotal: 0, waitSumTotal: 0 };
}

/**
 * True (non-rolling) average wait and throughput over [fromTick, toTick), derived from
 * cumulative counters rather than the engine's 60s rolling window. `finalCumulative`, when
 * given, is used for the `toTick` end instead of a sampled-row lookup - the final engine
 * snapshot's cumulative totals are exact, not just the nearest sample.
 */
function segmentStats(cumulativeByTick, fromTick, toTick, dt, finalCumulative = null) {
    const before = cumulativeAtOrBefore(cumulativeByTick, fromTick);
    const after = finalCumulative ?? cumulativeAtOrBefore(cumulativeByTick, toTick);

    const clearedDelta = after.clearedTotal - before.clearedTotal;
    const waitDelta = after.waitSumTotal - before.waitSumTotal;
    const seconds = (toTick - fromTick) * dt;

    return {
        avgWaitTime: clearedDelta > 0 ? avgWait(waitDelta, clearedDelta) : null,
        throughputPerMin: seconds > 0 ? perMin(clearedDelta, seconds) : null,
        clearedTotal: clearedDelta,
    };
}

/**
 * How far back the trailing smoothing window in computeRecoverySeconds() reaches, in seconds.
 * Matched to this project's demand-fluctuation period (corridor.js's own default, and every
 * shipped corridor JSON's `fluctuationPeriodS`, is 300 - see equations.js's fluctuatingDemand())
 * so the smoothing exactly cancels that cycle's ripple. computeRecoverySeconds() is corridor-
 * agnostic (it only sees byTick, not the corridor config), so this is a hardcoded assumption,
 * not a derived value - revisit it if a corridor with a different fluctuation period ships.
 */
const RECOVERY_SMOOTHING_WINDOW_SECONDS = 300;

/**
 * Recovery time: seconds from power being RESTORED (`powerOutageEndTick`) until an aggregate
 * metric returns to, and then sustains, within tolerance of its own pre-outage baseline for the
 * rest of the run. Returns null for a normal-power run, or if that's never established before
 * the run ends.
 *
 * Generic over metric direction via `notRecoveredWhen`/`thresholdMultiplier`: throughput's
 * default (climb back to >= 80% of baseline) suits a "higher is better" metric; a "lower is
 * better" metric like wait time passes its own options (e.g. drop back to <= 125% of baseline)
 * - see the timeToRecoveryWaitSeconds* call sites below.
 *
 * "Sustains" is checked on a trailing RECOVERY_SMOOTHING_WINDOW_SECONDS-wide rolling average of
 * the metric, not the raw per-tick value, and not a suffix-to-end average either - both of
 * those were tried and both broke:
 *   - Raw per-tick "never dips below threshold again": this corridor's demand fluctuates on a
 *     fixed ~300s cycle, completely independently of the outage, so every controller's raw
 *     throughput legitimately troughs below any fixed threshold every ~150s, forever. That rule
 *     just measures which controller's noisiest dip happens to land latest in the sampled
 *     series - not a real recovery difference - and can inflate an otherwise-fine controller's
 *     number by an order of magnitude (see the results-page audit).
 *   - Suffix-mean-from-T-to-end: for a long post-restore window, a distant healthy tail
 *     mathematically dilutes an early bad patch enough to satisfy the threshold from T=0, so it
 *     reports "recovered instantly" even when the system was clearly still struggling right
 *     after restore.
 * A fixed-width trailing window avoids both: it's wide enough (one full demand cycle) to average
 * out the harmless cyclic ripple, but bounded, so a distant future tail can't retroactively
 * paper over how bad things were near T - the smoothed value at each point only reflects the
 * recent past. Scanning for the LAST point that trailing average dips below threshold, and
 * reporting the point right after it, means a real, sustained relapse (a demand-cycle peak
 * coinciding with the post-restore window, or an actual outage-driven second surge) still
 * correctly pushes the reported time out, while brief single-sample noise no longer can.
 *
 * Unlike the old permanent-outage build, power actually comes back on here, so this now
 * measures exactly what the dashboard copy says it does ("time to return to normal flow once
 * power is restored") rather than self-stabilization under a permanent all-way-stop fallback.
 */
function computeRecoverySeconds(
    byTick,
    powerOutageStartTick,
    powerOutageEndTick,
    dt,
    { thresholdMultiplier = 0.8, notRecoveredWhen = (value, threshold) => value < threshold } = {}
) {
    if (powerOutageStartTick == null || powerOutageEndTick == null) return null;

    const ticks = [...byTick.keys()].sort((a, b) => a - b);

    const preOutageTicks = ticks.filter((t) => t < powerOutageStartTick);
    if (!preOutageTicks.length) return null;
    const baseline = preOutageTicks.reduce((sum, t) => sum + byTick.get(t), 0) / preOutageTicks.length;
    const threshold = baseline * thresholdMultiplier;

    const postRestoreTicks = ticks.filter((t) => t >= powerOutageEndTick);
    const n = postRestoreTicks.length;
    if (!n) return null;

    // Trailing rolling average via two pointers: smoothed[i] = mean of samples with tick in
    // (tick_i - windowTicks, tick_i]. Deliberately trailing, not forward or centered - a forward
    // window shrinks to a single (raw, noise-sensitive) sample right at the array's end, which
    // is exactly the region this needs to be MOST stable in.
    const windowTicks = RECOVERY_SMOOTHING_WINDOW_SECONDS / dt;
    const smoothed = new Array(n);
    let windowStart = 0;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i += 1) {
        sum += byTick.get(postRestoreTicks[i]);
        count += 1;
        while (postRestoreTicks[i] - postRestoreTicks[windowStart] > windowTicks) {
            sum -= byTick.get(postRestoreTicks[windowStart]);
            count -= 1;
            windowStart += 1;
        }
        smoothed[i] = sum / count;
    }

    let lastBelowIndex = -1;
    smoothed.forEach((value, i) => {
        if (notRecoveredWhen(value, threshold)) lastBelowIndex = i;
    });
    if (lastBelowIndex === n - 1) return null; // never sustains recovery through run end

    const recoveredTick = postRestoreTicks[lastBelowIndex + 1];
    return round((recoveredTick - powerOutageEndTick) * dt, 1);
}

function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}
