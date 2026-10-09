/**
 * liveMetrics.js - the live statistics panel's numbers, collected once a simulated second.
 *
 * Read-only, like lockupWatch.js: it never moves a car, never draws from a random stream and
 * never touches a controller, so a run's trajectory is the same with it attached or not
 * (tests/js/trajectoryHash.test.mjs checks that). Only the browser simulator attaches one
 * (engine.setLiveMetrics()); batch and headless runs never build it, so they pay nothing.
 *
 * Every figure comes from metrics/definitions.js - the same functions engine.snapshot() and the
 * batch summary use - over the engine's own counters where it keeps them (wait, cleared,
 * cleared without stopping) and over two event hooks where it does not:
 *   onVehicleClear(car)        a vehicle leaving the network - its stop count
 *   onStopLineCross(car, gate) a vehicle crossing an arterial stop line - arrivals on green
 * Everything else is one scan of the vehicles per sample().
 */
import { carRenderPoint } from '../car.js';
import {
    arrivalsOnGreenPct,
    avgStopsPerVehicle,
    avgWait,
    avgWaitNow,
    carsInDriveways,
    densityVehPerKm,
    divertedPct,
    driftState,
    DRIFT_LOOKBACK_S,
    isBoxBlocked,
    isStopped,
    isStranded,
    meanDrivewayWaitS,
    meanTripDelayS,
    missedDrivewaysPct,
    pctOf,
    rollingAvgWait,
    rollingThroughputPerMin,
    throughputPerMin,
    zeroStopPct,
} from './definitions.js';

/** Controllers that are traffic lights - the ones load shedding turns dark. */
const SIGNAL_TYPES = new Set(['fixed', 'adaptive', 'greenWave']);
/** Sparkline length: 2 minutes of 1 Hz samples. */
export const SPARK_POINTS = 120;
/** The throughput-over-time chart keeps one point per this many seconds. */
export const CHART_EVERY_S = 10;
/** Throughput before a power cut is averaged over this long - the base live throughput is compared with. */
const PRE_CUT_LOOKBACK_S = 600;
/** A queue reaching this far past the upstream stop line has backed into that junction. */
const SPILLBACK_REACH_M = 25;
/** Fewest stopped vehicles on an approach that count as a queue reaching back. */
const SPILLBACK_MIN_QUEUE = 2;

const SPARK_KEYS = ['onNetwork', 'throughput', 'avgWait', 'stopsPerVeh', 'zeroStopPct', 'stranded'];

export class LiveMetrics {
    /** `dt`: the fixed timestep the caller ticks the engine at, so elapsed time is ticks x dt exactly, as the batch summary counts it. */
    constructor(engine, { dt = 0.1 } = {}) {
        this.engine = engine;
        this.dt = dt;
        /** Whether sample() also builds the map overlays' geometry (queue heatmap points, per-road density). */
        this.wantOverlays = false;
        this._buildRoads();
        this.reset();
    }

    /** The per-road table's rows and every road's lane-km - fixed by the layout. */
    _buildRoads() {
        const engine = this.engine;
        this.laneKmByRoad = new Map();
        for (const carriageway of engine.carriageways) {
            const id = carriageway.arterial.id;
            this.laneKmByRoad.set(id, (this.laneKmByRoad.get(id) ?? 0) + (carriageway.lengthM * carriageway.road.lanes) / 1000);
        }
        for (const connector of engine.layout.connectors) {
            const dirs = engine.connectorDirs.get(connector.id);
            const lanes = dirs.fwd.road.lanes + dirs.rev.road.lanes;
            this.laneKmByRoad.set(connector.id, (connector.routeLengthM * lanes) / 1000);
        }
        this.laneKmTotal = [...this.laneKmByRoad.values()].reduce((a, b) => a + b, 0);

        this.roadRows = [
            ...engine.layout.arterials
                .filter((arterial) => engine.carriagewaysByArterial.get(arterial.id).some((c) => c.road.statsKey !== 'side'))
                .map((arterial) => ({ key: arterial.id, name: arterial.shortName ?? arterial.name, arterial, bucket: () => engine.arterialState.get(arterial.id).stats })),
            ...(engine.layout.connectors.some((c) => c.scope === 'arterial')
                ? [{ key: 'arterialConnectors', name: 'Arterial cross streets', arterial: null, bucket: () => engine.arterialConnectorStats }]
                : []),
            { key: 'side', name: 'Side streets', arterial: null, bucket: () => engine.sideStreetStats },
        ];
    }

    /** Starts every count over - on Reset, a new replay, and a replay's end of warm-up (with engine.resetStats()). */
    reset() {
        const engine = this.engine;
        this.startTickNo = engine.tickNo ?? 0;
        this.clears = 0;
        this.stopsTotal = 0;
        this.arrivals = 0;
        this.arrivalsOnGreen = 0;
        this.spilled = new Set();
        this.spillbackEvents = 0;
        this.blockedNodes = new Set();
        this.blockedEvents = 0;
        this.boxStoppedSince = new Map();
        this.arrivalsLostAtStart = engine.accounting?.arrivalsLost ?? 0;
        this.spark = Object.fromEntries(SPARK_KEYS.map((key) => [key, []]));
        this.waitSeries = [];
        this.throughputSeries = [];
        this.chart = [];
        this.outages = [];
        this.power = { state: engine.powerState, sinceS: 0, preCutThroughput: null };
        if (engine.powerState === 'load_shedding') this.outages.push({ fromS: 0, toS: null });
        this.latest = null;
    }

    /* ------------------------------------------------------- engine hooks */

    onVehicleClear(car) {
        this.clears += 1;
        this.stopsTotal += car.stopCount ?? 0;
    }

    /** A vehicle crossing a stop line on an arterial: an arrival on green if it crossed on green without stopping since the last one. */
    onStopLineCross(car, gate) {
        const stopsOnApproach = (car.stopCount ?? 0) - (car.stopMark ?? 0);
        car.stopMark = car.stopCount ?? 0;
        if (!SIGNAL_TYPES.has(gate.info.controllerType)) return;
        this.arrivals += 1;
        if (stopsOnApproach === 0 && gate.info.controller.isArterialGreen()) this.arrivalsOnGreen += 1;
    }

    /* ------------------------------------------------------------ sample */

    /** Seconds since the last reset, counted in ticks like runHeadless.js counts its measured window. */
    elapsedS() {
        return ((this.engine.tickNo ?? 0) - this.startTickNo) * this.dt;
    }

    /** One 1 Hz sample: scans the vehicles once and returns (and keeps as `latest`) everything the panel shows. */
    sample() {
        const engine = this.engine;
        const nowS = engine.simTimeS;
        const elapsedS = this.elapsedS();

        const cars = this._scanCars();
        const queues = this._scanApproaches();
        const blocked = this._scanBoxes(nowS);
        const total = engine.totalStats;

        let stranded = 0;
        for (const since of engine.lockupWatch.stillSinceS.values()) if (isStranded(nowS - since)) stranded += 1;

        let signalsTotal = 0;
        let signalsDark = 0;
        for (const info of engine.nodesInfo.values()) {
            const darkSignal = info.controllerType === 'allWayStop' && info.node.control !== 'allWayStop';
            if (darkSignal) signalsDark += 1;
            if (darkSignal || SIGNAL_TYPES.has(info.controllerType)) signalsTotal += 1;
        }

        const throughputNow = rollingThroughputPerMin(total.recentClears);
        const avgWaitRolling = rollingAvgWait(total.recentClears);
        this._trackPower(elapsedS);
        push(this.waitSeries, avgWaitRolling, DRIFT_LOOKBACK_S);
        push(this.throughputSeries, throughputNow, PRE_CUT_LOOKBACK_S);
        const lastChartS = this.chart.length ? this.chart[this.chart.length - 1].tS : -Infinity;
        if (elapsedS - lastChartS >= CHART_EVERY_S) this.chart.push({ tS: elapsedS, throughput: throughputNow });

        const stopsPerVeh = avgStopsPerVehicle(this.stopsTotal, this.clears);
        const zeroStop = zeroStopPct(total.clearedWithoutStopTotal, total.clearedTotal);
        const values = {
            onNetwork: cars.onNetwork,
            throughput: throughputNow,
            avgWait: avgWaitRolling,
            stopsPerVeh,
            zeroStopPct: zeroStop,
            stranded,
        };
        for (const key of SPARK_KEYS) push(this.spark[key], values[key], SPARK_POINTS);

        const drift = driftState(this.waitSeries);
        const routing = engine.routingActive
            ? {
                  divertedPct: divertedPct(engine.routingStats),
                  missedDrivewaysPct: missedDrivewaysPct(engine.routingStats),
                  missedTurns: engine.routingStats.missedTurns,
                  lostArrivals: Math.round(engine.accounting.arrivalsLost - this.arrivalsLostAtStart),
                  drivewayWaitS: meanDrivewayWaitS(engine.routingStats),
                  carsInDriveways: carsInDriveways(engine.departures),
                  tripDelayS: meanTripDelayS(engine.routingStats),
              }
            : null;

        const queueByKey = new Map();
        for (const q of queues.list) queueByKey.set(q.roadKey, (queueByKey.get(q.roadKey) ?? 0) + q.queue);

        this.latest = {
            simTimeS: nowS,
            elapsedS,
            onNetwork: cars.onNetwork,
            completed: total.clearedTotal,
            throughputPerMin: throughputNow,
            throughputRunPerMin: elapsedS > 0 ? throughputPerMin(total.clearedTotal, elapsedS) : 0,
            avgWaitRolling,
            avgWaitRun: avgWait(total.waitSumTotal, total.clearedTotal),
            tripDelayS: routing?.tripDelayS ?? null,
            avgSpeedKph: cars.moving ? (cars.movingSpeedSum / cars.moving) * 3.6 : null,
            stopped: cars.stopped,
            stopsPerVeh,
            zeroStopPct: zeroStop,
            arrivalsOnGreenPct: arrivalsOnGreenPct(this.arrivalsOnGreen, this.arrivals),
            avgQueue: queues.list.length ? queues.list.reduce((s, q) => s + q.queue, 0) / queues.list.length : 0,
            maxQueue: queues.max,
            spillbackNow: this.spilled.size,
            spillbackEvents: this.spillbackEvents,
            blockedNow: blocked.size,
            blockedEvents: this.blockedEvents,
            stranded,
            densityVehPerKm: densityVehPerKm(cars.onNetwork, this.laneKmTotal),
            signalsDark,
            signalsTotal,
            power: {
                state: this.power.state,
                forS: elapsedS - this.power.sinceS,
                /** Live throughput as % of the mean in the 10 min before the latest cut - during the outage and after restore. */
                recoveryPct: this.power.preCutThroughput == null ? null : pctOf(throughputNow, this.power.preCutThroughput),
            },
            drift: drift.state,
            driftRatio: drift.driftRatio,
            worst: cars.worst ? { id: cars.worst.id, waitS: cars.worst.totalWaitS, roadName: engine.carInfo(cars.worst.id)?.roadName ?? null } : null,
            routing,
            roads: this.roadRows.map((row) => {
                const bucket = row.bucket();
                const live = cars.byKey.get(row.key);
                return {
                    key: row.key,
                    name: row.name,
                    onRoad: live?.onRoad ?? 0,
                    avgWaitNow: avgWaitNow(live?.stopped ?? []),
                    clearedPerMin: rollingThroughputPerMin(bucket.recentClears),
                    zeroStopPct: zeroStopPct(bucket.clearedWithoutStopTotal, bucket.clearedTotal),
                    queue: queueByKey.get(row.key) ?? 0,
                    clearedTotal: bucket.clearedTotal,
                    clearedByNode: row.arterial ? row.arterial.intersections.map((node) => ({ node, cleared: bucket.clearedByNode[node.id] ?? 0 })) : null,
                };
            }),
            overlays: this.wantOverlays
                ? {
                      queues: queues.list.filter((q) => q.points.length).map((q) => ({ points: q.points, queue: q.queue })),
                      density: new Map([...cars.byRoad].map(([id, n]) => [id, densityVehPerKm(n, this.laneKmByRoad.get(id) ?? 0)])),
                  }
                : null,
        };
        return this.latest;
    }

    /** Sparkline series, oldest first. */
    sparkline(key) {
        return this.spark[key];
    }

    /** The throughput-over-time chart's points and the outage windows on the same clock (s since reset). */
    chartSeries() {
        return { points: this.chart, outages: this.outages };
    }

    /* ----------------------------------------------------------- internals */

    _trackPower(elapsedS) {
        const state = this.engine.powerState;
        if (state === this.power.state) return;
        if (state === 'load_shedding') {
            const before = this.throughputSeries;
            this.power.preCutThroughput = before.length ? before.reduce((a, b) => a + b, 0) / before.length : null;
            this.outages.push({ fromS: elapsedS, toS: null });
        } else {
            const open = this.outages[this.outages.length - 1];
            if (open && open.toS == null) open.toS = elapsedS;
        }
        this.power.state = state;
        this.power.sinceS = elapsedS;
    }

    /** One pass over every vehicle: counts, speeds, the longest wait, and per road what the table shows. */
    _scanCars() {
        const engine = this.engine;
        const result = { onNetwork: 0, stopped: 0, moving: 0, movingSpeedSum: 0, worst: null, byKey: new Map(), byRoad: new Map() };
        const visit = (car, key, roadId) => {
            result.onNetwork += 1;
            if (isStopped(car.speedMps)) result.stopped += 1;
            else {
                result.moving += 1;
                result.movingSpeedSum += car.speedMps;
            }
            if (!result.worst || car.totalWaitS > result.worst.totalWaitS) result.worst = car;
            let entry = result.byKey.get(key);
            if (!entry) result.byKey.set(key, (entry = { onRoad: 0, stopped: [] }));
            entry.onRoad += 1;
            if (car.stoppedNow) entry.stopped.push(car);
            if (roadId) result.byRoad.set(roadId, (result.byRoad.get(roadId) ?? 0) + 1);
        };
        for (const carriageway of engine.carriageways) {
            for (const lane of engine.carriagewayState.get(carriageway.id).lanes) for (const car of lane.cars) visit(car, car.road.statsKey, carriageway.arterial.id);
        }
        for (const [connectorId, state] of engine.connectorState) {
            for (const dirKey of ['fwd', 'rev']) for (const lane of state[dirKey].lanes) for (const car of lane.cars) visit(car, car.road.statsKey, connectorId);
        }
        // In the box the wait belongs to the road being left (WAIT_ACCOUNTING), so the car does too.
        for (const car of engine.turningCars) visit(car, car.turnFromKey ?? car.road.statsKey, null);
        return result;
    }

    /**
     * Every approach to every junction: its queue (stopped vehicles between the stop line and the
     * stop line before it on the same road) and whether that queue reaches back into the junction
     * upstream - spillback.
     */
    _scanApproaches() {
        const engine = this.engine;
        const list = [];
        let max = null;
        const spilledNow = new Set();
        for (const info of engine.nodesInfo.values()) {
            for (const gate of [...info.arterialGates, ...info.crossGates]) {
                const road = gate.carriageway ? gate.carriageway.road : gate.dir.road;
                const roadGates = gate.carriageway ? gate.carriageway.gates : gate.dir.gates;
                const segments = [{ lanes: engine._gateLanes(gate), roadGates, stopLineM: gate.stopLineDistanceM }];
                const join = engine.feedersByGate.get(gate);
                if (join) segments.push({ lanes: join.from.lanes(), roadGates: join.from.gates ?? [], stopLineM: join.from.lengthM + gate.stopLineDistanceM });

                let queue = 0;
                let reachesBack = false;
                const queued = [];
                for (const { lanes, roadGates: gates, stopLineM } of segments) {
                    const previousStopM = Math.max(-Infinity, ...gates.map((g) => g.stopLineDistanceM).filter((m) => m < stopLineM));
                    const fromM = Number.isFinite(previousStopM) ? previousStopM : 0;
                    for (const lane of lanes) {
                        for (const car of lane.cars) {
                            if (!car.stoppedNow || car.distanceM <= fromM || car.distanceM > stopLineM) continue;
                            queue += 1;
                            if (Number.isFinite(previousStopM) && car.distanceM <= previousStopM + SPILLBACK_REACH_M) reachesBack = true;
                            if (this.wantOverlays) queued.push(car);
                        }
                    }
                }

                const key = `${info.node.id}|${gate.carriageway?.id ?? `${gate.connector.id}:${gate.dirKey}`}`;
                if (reachesBack && queue >= SPILLBACK_MIN_QUEUE) spilledNow.add(key);
                const entry = {
                    key,
                    nodeId: info.node.id,
                    nodeName: info.node.name,
                    roadName: engine._roadName(road),
                    roadKey: road.statsKey,
                    queue,
                    points: queued.sort((a, b) => b.distanceM - a.distanceM).map((car) => carRenderPoint(car)),
                };
                list.push(entry);
                if (queue > 0 && (!max || queue > max.queue)) max = entry;
            }
        }
        for (const key of spilledNow) if (!this.spilled.has(key)) this.spillbackEvents += 1;
        this.spilled = spilledNow;
        return { list, max: max && { queue: max.queue, nodeId: max.nodeId, nodeName: max.nodeName, roadName: max.roadName } };
    }

    /** Junctions with a turning or circulating vehicle stopped in them longer than BLOCKED_BOX_S. */
    _scanBoxes(nowS) {
        const engine = this.engine;
        const seen = new Set();
        const blockedNow = new Set();
        for (const car of engine.turningCars) {
            const path = car.turnPath;
            if (path.driveway || path.fromDriveway) continue;
            const nodeId = turnNodeId(path, engine.nodesInfo);
            if (!nodeId) continue;
            seen.add(car.id);
            if (!isStopped(car.speedMps)) {
                this.boxStoppedSince.delete(car.id);
                continue;
            }
            const since = this.boxStoppedSince.get(car.id) ?? nowS;
            this.boxStoppedSince.set(car.id, since);
            if (isBoxBlocked(nowS - since)) blockedNow.add(nodeId);
        }
        for (const id of [...this.boxStoppedSince.keys()]) if (!seen.has(id)) this.boxStoppedSince.delete(id);
        for (const nodeId of blockedNow) if (!this.blockedNodes.has(nodeId)) this.blockedEvents += 1;
        this.blockedNodes = blockedNow;
        return blockedNow;
    }
}

/**
 * The junction a turn path runs through, read off its key (engine.js builds them as
 * `<node>:<connector>:...`, `<road>@<node>:...` and `<node>:ring:<approach>`), or null.
 */
export function turnNodeId(path, nodesInfo) {
    if (path.ringNodeId) return path.ringNodeId;
    const key = path.key ?? '';
    const id = key.includes('@') ? key.split('@')[1].split(':')[0] : key.split(':')[0];
    return nodesInfo.has(id) ? id : null;
}

function push(series, value, cap) {
    series.push(value);
    if (series.length > cap) series.shift();
}
