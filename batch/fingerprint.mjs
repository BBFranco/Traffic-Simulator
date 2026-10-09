/**
 * fingerprint.mjs - legacy-mode regression check, and a quick destination-mode health check.
 *
 * Runs the engine headless for a few seeds x controllers and hashes every
 * car's id, lane, position and speed on every tick. Two code versions that
 * print the same trajectory hash moved every car identically; the metric
 * columns alongside show what a stats-only change did to the numbers.
 *
 *   node batch\fingerprint.mjs [--corridor=hatfield-realistic] [--ticks=6000] [--seeds=1,2,3]
 *                              [--routing=random|destination] [--controllers=fixed,green_wave,adaptive]
 *
 * With --routing=destination it also reports the trips (pulled off / out of
 * the map / diverted), missed turns and reroutes, and the longest any one car
 * sat stopped - a deadlock shows up there as a stop as long as the run.
 */
import { hashRun, loadCorridor } from './trajectoryHash.mjs';
import { avgWait, zeroStopPct } from '../resources/js/sim/metrics/definitions.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const corridorId = args.corridor ?? 'hatfield-realistic';
const ticks = Number(args.ticks ?? 6000);
const seeds = (args.seeds ?? '1,2,3').split(',').map(Number);
const controllers = (args.controllers ?? 'fixed,green_wave,adaptive').split(',');
const routingMode = args.routing ?? null;
/** How often (ticks) the stuck-car check looks at every car. */
const STUCK_SAMPLE_TICKS = 10;

const config = loadCorridor(corridorId);

function run(seed, controllerMode) {
    const stoppedSince = new Map();
    let longestStop = { s: 0 };
    const { engine, trajectory } = hashRun({
        config,
        seed,
        controllerMode,
        routingMode,
        ticks,
        onTick: (engine, tick, cars) => {
            if (routingMode !== 'destination' || tick % STUCK_SAMPLE_TICKS !== 0) return;
            const seen = new Set();
            for (const car of cars) {
                if (!car.stoppedNow) continue;
                seen.add(car.id);
                if (!stoppedSince.has(car.id)) stoppedSince.set(car.id, engine.simTimeS);
                const s = engine.simTimeS - stoppedSince.get(car.id);
                if (s > longestStop.s) longestStop = { s, where: `${car.trip?.origin ?? '?'} -> ${car.trip?.destId ?? '?'}` };
            }
            for (const id of [...stoppedSince.keys()]) if (!seen.has(id)) stoppedSince.delete(id);
        },
    });

    // The total scope - every vehicle once. Summing the scopes would count a trip over several roads more than once.
    const { clearedTotal: cleared, waitSumTotal: waitSum, clearedWithoutStopTotal: noStop } = engine.snapshot().total;
    const accounting = engine.carAccounting();
    const row = {
        seed,
        controllerMode,
        trajectory,
        spawned: accounting.totalSpawned,
        balanced: accounting.balanced,
        cleared,
        avgWaitS: cleared ? +avgWait(waitSum, cleared).toFixed(3) : null,
        noStopPct: cleared ? +zeroStopPct(noStop, cleared).toFixed(2) : null,
    };
    if (routingMode === 'destination') {
        const r = engine.routingStats;
        Object.assign(row, {
            pulledOff: r.pulledOff,
            toExit: r.toExit,
            divertedPct: r.trips ? +((r.diverted / r.trips) * 100).toFixed(1) : null,
            missedTurns: r.missedTurns,
            missedDrivewaysPct: r.pulledOff ? +((r.missedDriveways / r.pulledOff) * 100).toFixed(1) : null,
            departed: r.departed,
            stillInDriveways: engine.departures.reduce((sum, d) => sum + d.waiting.length, 0),
            rerouted: r.rerouted,
            meanTripS: r.trips ? +(r.tripTimeSumS / r.trips).toFixed(1) : null,
            longestStopS: Math.round(longestStop.s),
        });
        if (longestStop.s > 300) console.log(`seed ${seed} ${controllerMode}: a car sat stopped ${Math.round(longestStop.s)} s (${longestStop.where})`);
    }
    return row;
}

const results = [];
for (const seed of seeds) for (const controllerMode of controllers) results.push(run(seed, controllerMode));
console.table(results);
