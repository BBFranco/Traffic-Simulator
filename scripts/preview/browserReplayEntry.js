// Browser bundle entry for scripts/preview/browserreplay.mjs: the same replay as longreplay.mjs, run inside Chromium's
// V8 rather than Node's, to tell a code fault from a JS-engine difference when a /results batch row won't replay in Node.
import { runHeadless } from '../../resources/js/sim/runHeadless.js';
import { LONG_PROTOCOL } from '../../resources/js/sim/batchSchedule.js';
import { EVENING_PROFILE } from '../../resources/js/sim/demandProfile.js';

window.replayLongRun = (raw, cfg, powerState) => {
    for (const street of [...(cfg.arterials ?? []), ...(cfg.connectors ?? [])]) {
        const o = raw.demandOverrides?.[street.id];
        if (o) street.demand = { ...street.demand, spawnRatePerLanePerMinMin: o.min, spawnRatePerLanePerMinMax: o.max, saturationFlowPerLanePerHour: o.saturationFlowPerLanePerHour };
    }
    const { summary } = runHeadless({
        seed: raw.seed,
        controllerMode: raw.controllerMode,
        sensorMode: raw.sensorMode,
        warmupTicks: raw.warmupTicks,
        powerOutageStartTick: powerState === 'load_shedding' ? LONG_PROTOCOL.powerOutageStartTick : null,
        powerOutageEndTick: powerState === 'load_shedding' ? LONG_PROTOCOL.powerOutageEndTick : null,
        rollingSchedule: powerState === 'rolling_blackout' ? LONG_PROTOCOL.rollingSchedule : null,
        corridorConfig: cfg,
        durationTicks: LONG_PROTOCOL.measuredTicks,
        dt: 0.1,
        routingMode: raw.routingMode,
        demandProfile: { profile: EVENING_PROFILE, startClockS: LONG_PROTOCOL.startClockS },
        sampleEverySeconds: LONG_PROTOCOL.sampleEverySeconds,
    });
    return { avgWaitTime: summary.avgWaitTime, throughputPerMin: summary.throughputPerMin, longestStill: summary.diagnostics.lockup.longestStill };
};
