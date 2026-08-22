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
import { SimulationEngine } from './engine.js';

/**
 * @param seed             integer PRNG seed
 * @param controllerMode   'fixed' | 'adaptive' | 'green_wave' - applied to every arterial in the corridor
 * @param sensorMode       'none' | 'inductive_loop' | 'radar' | 'camera' | 'magnetometer'
 * @param powerEvent       tick number to trigger load shedding at, or null for a normal-power run
 * @param corridorConfig   parsed corridor JSON (same shape `buildLayout()` already takes)
 * @param durationTicks    number of FIXED_DT_S ticks to run
 * @param dt               physics timestep in seconds (must match the live sim's FIXED_DT_S for the sanity-check comparison in build step 13 to be meaningful)
 * @param sampleEverySeconds  how often (sim time) to emit a CSV row - spec explicitly says not literally every tick
 * @returns { rows: object[], summary: object }
 */
export function runHeadless({
    seed,
    controllerMode,
    sensorMode,
    powerEvent = null,
    corridorConfig,
    durationTicks,
    dt = 0.1,
    sampleEverySeconds = 1,
}) {
    const layout = buildLayout(corridorConfig);
    const engine = new SimulationEngine(layout);

    const arterialModes = {};
    const demand = {};
    for (const arterial of layout.arterials) {
        arterialModes[arterial.id] = controllerMode;
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
    });

    const sampleEveryTicks = Math.max(1, Math.round(sampleEverySeconds / dt));
    const rows = [];
    let powerTriggered = false;

    for (let tick = 0; tick < durationTicks; tick += 1) {
        if (powerEvent != null && !powerTriggered && tick >= powerEvent) {
            engine.setManualLoadShedding(true);
            powerTriggered = true;
        }

        engine.tick(dt);

        if (tick % sampleEveryTicks === 0) {
            const snap = engine.snapshot();
            for (const arterial of layout.arterials) {
                const s = snap.stats[arterial.id];
                const row = {
                    tick,
                    arterial: arterial.id,
                    avgWaitTime: round(s.avgWaitRolling, 3),
                    throughputPerMin: s.throughputPerMin,
                    clearedWithoutStopping: s.clearedWithoutStopPct == null ? '' : round(s.clearedWithoutStopPct, 1),
                    powerState: snap.powerState,
                };
                for (const info of engine.nodeInfosByArterial.get(arterial.id) ?? []) {
                    row[`queueLength_${info.node.id}`] = s.queues[info.node.id];
                }
                rows.push(row);
            }
        }
    }

    const accounting = engine.carAccounting();
    const summary = buildSummary({ layout, engine, seed, controllerMode, sensorMode, powerEvent, corridorConfig, durationTicks, dt, rows, accounting });

    return { rows, summary };
}

function buildSummary({ layout, engine, seed, controllerMode, sensorMode, powerEvent, corridorConfig, durationTicks, dt, rows, accounting }) {
    const finalSnap = engine.snapshot();

    const perArterial = layout.arterials.map((arterial) => {
        const s = finalSnap.stats[arterial.id];
        return {
            id: arterial.id,
            avgWaitTime: s.avgWaitRolling,
            throughputPerMin: s.throughputPerMin,
            clearedTotal: s.clearedTotal,
            clearedWithoutStopTotal: s.clearedWithoutStopTotal,
            pctClearedWithoutStop: s.clearedWithoutStopPct,
        };
    });

    // Aggregated to match `simulation_runs`' single-scalar-per-run schema
    // (build step 16). Throughput is additive (sum across arterials); wait
    // time and cleared-without-stop % are weighted by each arterial's own
    // cleared count so a busier arterial counts for more, not an unweighted
    // average of two possibly very different sample sizes.
    const clearedTotal = perArterial.reduce((sum, a) => sum + a.clearedTotal, 0);
    const clearedWithoutStopTotal = perArterial.reduce((sum, a) => sum + a.clearedWithoutStopTotal, 0);
    const throughputPerMin = perArterial.reduce((sum, a) => sum + a.throughputPerMin, 0);
    const avgWaitTime = clearedTotal
        ? perArterial.reduce((sum, a) => sum + a.avgWaitTime * a.clearedTotal, 0) / clearedTotal
        : 0;
    const pctClearedWithoutStop = clearedTotal ? (clearedWithoutStopTotal / clearedTotal) * 100 : null;

    return {
        seed,
        controllerMode,
        powerState: powerEvent != null ? 'load_shedding' : 'normal',
        sensorMode: controllerMode === 'fixed' ? null : sensorMode, // fixed-time never reads sensors (spec's DB schema note)
        corridorConfig: corridorConfig.id,
        avgWaitTime,
        throughputPerMin,
        pctClearedWithoutStop,
        timeToRecoverySeconds: computeRecoverySeconds(rows, powerEvent, dt, layout.arterials),
        perArterial,
        carAccounting: accounting,
        durationTicks,
        rawConfig: { seed, controllerMode, sensorMode, powerEvent, corridorConfig: corridorConfig.id, durationTicks, dt },
    };
}

/**
 * Recovery time: seconds from the load-shedding event until aggregate
 * throughput first climbs back to >=80% of its own pre-event baseline. Not a
 * cited formula (there isn't a standard one for this) - a documented,
 * reproducible proxy, same spirit as the adaptive threshold heuristic in
 * equations.js. Returns null for a normal-power run, or if it never recovers
 * within the run's duration.
 */
function computeRecoverySeconds(rows, powerEventTick, dt, arterials) {
    if (powerEventTick == null) return null;

    const byTick = new Map();
    for (const row of rows) {
        const total = (byTick.get(row.tick) ?? 0) + row.throughputPerMin;
        byTick.set(row.tick, total);
    }
    const ticks = [...byTick.keys()].sort((a, b) => a - b);

    const preEventTicks = ticks.filter((t) => t < powerEventTick);
    if (!preEventTicks.length) return null;
    const baseline = preEventTicks.reduce((sum, t) => sum + byTick.get(t), 0) / preEventTicks.length;
    const threshold = baseline * 0.8;

    const recoveredTick = ticks.find((t) => t >= powerEventTick && byTick.get(t) >= threshold);
    if (recoveredTick == null) return null;
    return round((recoveredTick - powerEventTick) * dt, 1);
}

function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}
