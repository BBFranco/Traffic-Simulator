/**
 * engine.js - build steps 2-10.
 *
 * Pure step(dt) simulation: no rendering, no requestAnimationFrame, no DOM.
 * `simulator.js` owns the animation loop and calls `tick()` on a fixed
 * timestep; `runHeadless.js` (build step 13) calls the exact same class the
 * same way, just without a render step after each tick - that reuse is the
 * entire reason this file does not know the canvas exists.
 */
import { SeededRandom } from './rng.js';
import {
    Car,
    stepCar,
    resetCarIdCounter,
    carWorldPoint,
    carRenderPoint,
    carRenderHeading,
    carAcceleration,
    VEHICLE_TYPES,
    TRUCK_VEHICLE_TYPES,
} from './car.js';
import { nextPoissonArrival, fluctuatingDemand, hasSufficientCall, mobilShouldChangeLane } from './equations.js';
import { FixedTimeController } from './controllers/fixedTime.js';
import { AdaptiveController } from './controllers/adaptive.js';
import { AllWayStopController, MIN_STOP_DWELL_S } from './controllers/allWayStop.js';
import { buildGreenWaveControllers } from './controllers/greenWave.js';
import { readQueueLength, detectPresenceAtStopLine, sensorAvailable } from './sensors.js';

/** Upstream window counted as "queued" for the stats-footer chips. */
const QUEUE_WINDOW_M = 150;
/** Matches the yellow/all-red constants every controller (fixedTime/adaptive/greenWave) times its transition on - only used here to caption the hover tooltip's countdown. */
const YELLOW_S = 3;
const ALL_RED_S = 1;
/** Wait-time/throughput rolling window - also makes "cleared in the window" equal cleared-per-minute. */
const ROLLING_WINDOW_S = 60;
export const CHART_SAMPLE_INTERVAL_S = 0.5;
/** Minimum clearance ahead of a freshly spawned/diverted car so it doesn't start already emergency-braking. */
const SPAWN_CLEARANCE_M = 4;
/** How close to a connector-bearing stop line a car must be before it rolls the cross-routing dice (build step 9). */
const CROSS_DECISION_WINDOW_M = 5;
/** Cross-street traffic is generally lower-speed than the arterial; corridor.json has no per-connector speed field. */
const CONNECTOR_TARGET_SPEED_KPH = 40;
/** Sprite variety (build step 11) - must match renderer.js PALETTE.carPalette.length in both themes. */
const CAR_PALETTE_SIZE = 4;
/** Widest randomised driver reaction lag (seconds) before pulling away from a stop - see car.js:stepCar()'s startup gate. */
const MAX_STARTUP_DELAY_S = 0.8;
/** Per-car desired-speed jitter, as a fraction either side of the road's target speed - real drivers don't all pick the exact same cruising speed. */
const DESIRED_SPEED_JITTER = 0.08;

/** MOBIL (equations.js) is suppressed within this many metres of a car's own spawn point, so it doesn't immediately dart across lanes before it has settled into traffic. */
const LANE_CHANGE_MIN_DISTANCE_M = 15;
/** ...and within this many metres of the next stop line, so a car isn't still weaving lanes right as _maybeCrossRoute()'s "only the kerb lane can turn" decision window opens. */
const LANE_CHANGE_STOPLINE_EXCLUSION_M = 20;
/** Minimum physical bumper-to-bumper clearance a lane change may leave, on top of MOBIL's own acceleration-based safety criterion - stops a change from ever visually overlapping two cars. */
const MIN_LANE_CHANGE_GAP_M = 2;
/** Seconds a car commits to a lane after changing before it's allowed to evaluate another one - stops unrealistic tick-by-tick weaving. */
const LANE_CHANGE_COOLDOWN_S = 4;

function jitteredDesiredSpeed(v0, rng) {
    return v0 * (1 - DESIRED_SPEED_JITTER + 2 * DESIRED_SPEED_JITTER * rng.next());
}

function nearestAhead(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a.distanceM <= b.distanceM ? a : b;
}

function negateHeading(h) {
    return { x: -h.x, y: -h.y };
}

/** `car`'s nearest leader/follower within `carsSortedDesc` (front-first, as every lane array is kept sorted) - excludes `car` itself so this is safe to call whether or not `car` is currently a member. */
function neighborsInLane(carsSortedDesc, car) {
    let leader = null;
    let follower = null;
    for (const c of carsSortedDesc) {
        if (c === car) continue;
        if (c.distanceM > car.distanceM) leader = c;
        else if (follower === null) {
            follower = c;
            break;
        }
    }
    return { leader, follower };
}

export class SimulationEngine {
    constructor(layout) {
        this.layout = layout;
        this.nodesInfo = new Map(); // nodeId -> info
        this.nodeInfosByArterial = new Map(); // arterialId -> info[]
        this.connectorsById = new Map(layout.connectors.map((c) => [c.id, c]));
        this.connectorDirs = new Map(); // connectorId -> { fwd, rev }
        this.arterialState = new Map(); // arterialId -> per-run state
        this.connectorState = new Map(); // connectorId -> per-run state
        this.rng = new SeededRandom(1);
        this.simTimeS = 0;
        this.powerState = 'normal';
        this.power = { manual: false, scheduled: false, offMinutes: 2, periodMinutes: 8 };
        this.sensorMode = 'inductive_loop';
        this.batteryBackedSensors = true;
        /** Fraction (0-1) of newly-spawned vehicles that are trucks, split evenly across TRUCK_VEHICLE_TYPES - see setTruckRatio()/_rollVehicleType(). */
        this.truckRatio = 0;
        this.accounting = { totalSpawned: 0, totalClearedNetwork: 0 };

        for (const arterial of layout.arterials) {
            const infos = [];
            for (const node of arterial.intersections) {
                const distanceFromStartM = arterial.approachLengthM + node.sAlongM;
                const arterialApproach = node.approaches.find((a) => a.kind === 'arterial');
                const info = {
                    node,
                    arterial,
                    stopLineDistanceM: distanceFromStartM - arterialApproach.setbackM,
                    controller: null,
                    controllerType: null,
                    // Per-phase "how long has this approach had an uninterrupted call" - only
                    // consumed by _isOtherCallSufficient() under a narrow-window sensor mode.
                    callPersistenceS: [0, 0],
                };
                this.nodesInfo.set(node.id, info);
                infos.push(info);
            }
            this.nodeInfosByArterial.set(arterial.id, infos);
        }

        // Connector direction geometry (build step 9) - purely derived from the
        // static layout, so this only ever needs computing once, not per reset().
        // Both directions share the SAME two entry points (the two linked
        // nodes): 'fwd' travels the connector's own heading starting at node a,
        // 'rev' travels the opposite heading starting at node b. A car turning
        // onto the connector AWAY from the other node (into the near stub) is
        // just a car entering that same direction group partway through, at
        // distanceM = spanM - see _divertCarToConnector().
        for (const connector of layout.connectors) {
            const nodeA = this.nodesInfo.get(connector.nodeIds[0]).node;
            const nodeB = this.nodesInfo.get(connector.nodeIds[1]).node;
            const perSide = connector.twoWay ? Math.max(1, Math.floor(connector.lanes / 2)) : connector.lanes;

            // Distance 0 in each direction's frame is the connector's own stub tip
            // (connector.startPoint/endPoint - see corridor.js), not the node itself,
            // so natively-spawned side-street cars enter off-map and drive up to the
            // junction, the same way arterial cars enter at arterial.startPoint. A
            // connector links two REAL intersections (one per linked arterial), so
            // a car travelling its full length passes two signals in sequence: its
            // own near node first (at stubLengthM), then the far node (at
            // stubLengthM + spanM). Both are real gates - checking only the far one
            // let a car sail through the near intersection on red.
            //
            // Each gate's stop-line distance is pulled back from the node's raw
            // centre distance by half of THAT node's arterial width - the same
            // setback corridor.js gives every 'cross' approach - so a car stops
            // before the junction box instead of halfway across it.
            const nodeAStopSetbackM = nodeA.arterialRoadWidthM / 2;
            const nodeBStopSetbackM = nodeB.arterialRoadWidthM / 2;
            this.connectorDirs.set(connector.id, {
                fwd: {
                    road: {
                        heading: connector.heading,
                        startPoint: connector.startPoint,
                        roadWidthM: connector.roadWidthM,
                        lanes: perSide,
                        laneWidthM: connector.laneWidthM,
                        // Set only for a curved connector (a ramp) - see corridor.js's
                        // roadPointAt(), the seam that makes car.js/this file's own
                        // distanceM/speedMps-only physics agnostic to curve vs. straight.
                        curve: connector.curve,
                    },
                    nearGateNode: nodeA,
                    nearGateDistanceM: connector.stubLengthM - nodeAStopSetbackM,
                    gateNode: nodeB,
                    gateDistanceM: connector.stubLengthM + connector.spanM - nodeBStopSetbackM,
                },
                rev: {
                    road: {
                        heading: negateHeading(connector.heading),
                        startPoint: connector.endPoint,
                        roadWidthM: connector.roadWidthM,
                        lanes: connector.twoWay ? perSide : 0,
                        laneWidthM: connector.laneWidthM,
                        curve: connector.curveReversed,
                    },
                    nearGateNode: nodeB,
                    nearGateDistanceM: connector.stubLengthM - nodeBStopSetbackM,
                    gateNode: nodeA,
                    gateDistanceM: connector.stubLengthM + connector.spanM - nodeAStopSetbackM,
                },
            });
        }
    }

    /** Full restart: new seed, fresh cars, fresh stats. Also what the seed-determinism check (build step 12) needs. */
    reset({ seed, arterialModes, demand, sensorMode, batteryBackedSensors, power, truckRatio = 0 }) {
        this.rng.reseed(seed);
        resetCarIdCounter();
        this.simTimeS = 0;
        this.sensorMode = sensorMode;
        this.batteryBackedSensors = batteryBackedSensors;
        this.truckRatio = truckRatio;
        this.power = {
            manual: !!power.loadShedding,
            scheduled: !!power.scheduledOutages,
            offMinutes: power.offMinutes,
            periodMinutes: power.periodMinutes,
        };
        this.powerState = this._computePowerState();
        this.accounting = { totalSpawned: 0, totalClearedNetwork: 0 };

        this.arterialState.clear();
        for (const arterial of this.layout.arterials) {
            const spawnRatePerLanePerMin = demand[arterial.id] ?? arterial.demand.spawnRatePerLanePerMin;
            this.arterialState.set(arterial.id, {
                mode: arterialModes[arterial.id] ?? arterial.mode,
                spawnRatePerLanePerMin,
                saturationFlowPerLanePerHour: arterial.demand.saturationFlowPerLanePerHour,
                road: {
                    heading: arterial.heading,
                    startPoint: arterial.startPoint,
                    roadWidthM: arterial.roadWidthM,
                    lanes: arterial.lanes,
                    laneWidthM: arterial.laneWidthM,
                    // Set only for a curved arterial - see corridor.js's roadPointAt().
                    // curveOffsetM lines up this road's distanceM=0 (the approach
                    // lead-in's spawn point) with the curve's own t=0 (the first node).
                    curve: arterial.curve,
                    curveOffsetM: arterial.approachLengthM,
                },
                lanes: Array.from({ length: arterial.lanes }, () => ({
                    cars: [],
                    timerS: 0,
                    nextArrivalS: this._sampleArrival(this._liveSpawnRate(arterial.demand, spawnRatePerLanePerMin)),
                })),
                stats: {
                    clearedTotal: 0,
                    clearedWithoutStopTotal: 0,
                    recentClears: [],
                    clearedByNode: Object.fromEntries(arterial.intersections.map((node) => [node.id, 0])),
                },
                chartSamples: [],
                chartAccumS: 0,
            });
        }

        this.connectorState.clear();
        for (const connector of this.layout.connectors) {
            const dirs = this.connectorDirs.get(connector.id);
            const rate = this._liveSpawnRate(connector.demand, connector.demand.spawnRatePerLanePerMin);
            const makeLanes = (n) =>
                Array.from({ length: n }, () => ({ cars: [], timerS: 0, nextArrivalS: this._sampleArrival(rate) }));
            this.connectorState.set(connector.id, {
                fwd: { lanes: makeLanes(dirs.fwd.road.lanes) },
                rev: { lanes: makeLanes(dirs.rev.road.lanes) },
            });
        }

        this._rebuildAllControllers();
    }

    setArterialMode(arterialId, mode) {
        const state = this.arterialState.get(arterialId);
        if (!state) return;
        state.mode = mode;
        this._rebuildControllersForArterial(arterialId);
    }

    /** `id` is either an arterial id or a connector id - both carry a spawnRatePerLanePerMin. */
    setDemand(id, ratePerLanePerMin) {
        const arterialState = this.arterialState.get(id);
        if (arterialState) {
            arterialState.spawnRatePerLanePerMin = ratePerLanePerMin;
            this._recomputeTimingForArterial(id);
            return;
        }

        const connector = this.connectorsById.get(id);
        if (!connector) return;
        connector.demand.spawnRatePerLanePerMin = ratePerLanePerMin;
        this._recomputeTimingForConnectorArterials(id);
    }

    /**
     * Same idea as setDemand(), but for an id whose corridor config already
     * gave it a fluctuation range (corridor.js's buildDemand()) - moving
     * either handle is an explicit "re-survey the count" action, same as
     * dragging the flat slider, so the design flow (now the new midpoint)
     * and the Webster plan built from it both update; the live spawn rate
     * then keeps wandering within the new bounds same as before.
     */
    setDemandRange(id, minPerLanePerMin, maxPerLanePerMin) {
        const midpoint = (minPerLanePerMin + maxPerLanePerMin) / 2;

        const arterial = this.layout.arterials.find((a) => a.id === id);
        const arterialState = this.arterialState.get(id);
        if (arterial && arterialState) {
            arterial.demand.fluctuation = { ...arterial.demand.fluctuation, minPerLanePerMin, maxPerLanePerMin };
            arterial.demand.spawnRatePerLanePerMin = midpoint;
            arterialState.spawnRatePerLanePerMin = midpoint;
            this._recomputeTimingForArterial(id);
            return;
        }

        const connector = this.connectorsById.get(id);
        if (!connector) return;
        connector.demand.fluctuation = { ...connector.demand.fluctuation, minPerLanePerMin, maxPerLanePerMin };
        connector.demand.spawnRatePerLanePerMin = midpoint;
        this._recomputeTimingForConnectorArterials(id);
    }

    /** The rate that would actually be used to draw this id's next car arrival right now - read-only, never touches rng, safe to poll every frame for a UI readout. */
    liveSpawnRate(id) {
        const arterial = this.layout.arterials.find((a) => a.id === id);
        const arterialState = this.arterialState.get(id);
        if (arterial && arterialState) return this._liveSpawnRate(arterial.demand, arterialState.spawnRatePerLanePerMin);

        const connector = this.connectorsById.get(id);
        if (!connector) return null;
        return this._liveSpawnRate(connector.demand, connector.demand.spawnRatePerLanePerMin);
    }

    _recomputeTimingForConnectorArterials(connectorId) {
        const affectedArterialIds = new Set();
        for (const info of this.nodesInfo.values()) {
            if (info.node.connectorId === connectorId) affectedArterialIds.add(info.arterial.id);
        }
        for (const arterialId of affectedArterialIds) this._recomputeTimingForArterial(arterialId);
    }

    setSensorMode(mode) {
        this.sensorMode = mode;
    }

    setBatteryBackedSensors(value) {
        this.batteryBackedSensors = !!value;
    }

    /** Takes effect for vehicles spawned from now on - doesn't retroactively change cars already on the road. */
    setTruckRatio(ratio) {
        this.truckRatio = Math.min(1, Math.max(0, ratio));
    }

    /** Which vehicle type a newly-spawned car should be, per the current truck-mix slider - split evenly across TRUCK_VEHICLE_TYPES. */
    _rollVehicleType() {
        if (this.rng.next() >= this.truckRatio) return 'car';
        return TRUCK_VEHICLE_TYPES[Math.floor(this.rng.next() * TRUCK_VEHICLE_TYPES.length)];
    }

    setManualLoadShedding(active) {
        this.power.manual = !!active;
        this._syncPowerState();
    }

    setPowerSchedule({ scheduledOutages, offMinutes, periodMinutes }) {
        this.power.scheduled = !!scheduledOutages;
        if (offMinutes != null) this.power.offMinutes = offMinutes;
        if (periodMinutes != null) this.power.periodMinutes = periodMinutes;
        this._syncPowerState();
    }

    /** Advance the whole simulation by one fixed timestep. */
    tick(dt) {
        this.simTimeS += dt;
        this._syncPowerState();

        for (const info of this.nodesInfo.values()) {
            if (info.controllerType === 'adaptive') {
                const detected = this._vehicleDetectedAtStopLine(info, info.controller.phase);
                const otherCallSufficient = this._isOtherCallSufficient(info, info.controller.phase, dt);
                info.controller.tick(dt, detected, otherCallSufficient);
            } else if (info.controllerType === 'greenWave') {
                info.controller.tick(dt, this.simTimeS);
            } else {
                info.controller.tick(dt);
            }
        }

        for (const arterial of this.layout.arterials) {
            this._spawnForArterial(arterial, dt);
        }

        for (const arterial of this.layout.arterials) {
            this._stepArterialCars(arterial, dt);
        }

        for (const connector of this.layout.connectors) {
            this._spawnForConnector(connector, dt);
        }

        for (const connector of this.layout.connectors) {
            this._stepConnectorCars(connector, dt);
        }

        for (const state of this.arterialState.values()) {
            this._pruneRolling(state);
        }

        this._sampleChart(dt);
    }

    /** Everything the render loop / stats footer needs for one frame (or one row of headless output). */
    snapshot() {
        const cars = [];
        for (const arterial of this.layout.arterials) {
            for (const lane of this.arterialState.get(arterial.id).lanes) {
                for (const car of lane.cars) {
                    cars.push({
                        point: carRenderPoint(car),
                        stopped: car.stoppedNow,
                        heading: carRenderHeading(car),
                        colourIndex: car.colourIndex,
                        vehicleType: car.vehicleType,
                        lengthM: car.lengthM,
                        widthM: car.widthM,
                    });
                }
            }
        }
        for (const connector of this.layout.connectors) {
            const state = this.connectorState.get(connector.id);
            for (const dirKey of ['fwd', 'rev']) {
                for (const lane of state[dirKey].lanes) {
                    for (const car of lane.cars) {
                        cars.push({
                            point: carRenderPoint(car),
                            stopped: car.stoppedNow,
                            heading: carRenderHeading(car),
                            colourIndex: car.colourIndex,
                            vehicleType: car.vehicleType,
                            lengthM: car.lengthM,
                            widthM: car.widthM,
                        });
                    }
                }
            }
        }

        const signals = new Map();
        for (const [nodeId, info] of this.nodesInfo) {
            const dark = this.powerState === 'load_shedding';
            const isYellow = !dark && info.controllerType !== 'none' && info.controller.phaseState === 'yellow';
            signals.set(nodeId, {
                dark,
                arterialGreen: !dark && info.controller.isArterialGreen(),
                arterialYellow: isYellow && info.controller.phase === 0,
                crossGreen: !dark && info.controller.isCrossGreen(),
                crossYellow: isYellow && info.controller.phase === 1,
                // A highway merge point (an arterial with mode:"none") has no
                // signal at all, not just an unlit one - the renderer skips
                // drawing its stop lines/housings entirely instead of showing
                // a dark head, which would read as a broken light.
                freeFlow: info.controllerType === 'none',
            });
        }

        const stats = {};
        for (const arterial of this.layout.arterials) {
            const state = this.arterialState.get(arterial.id);
            const liveCars = state.lanes.flatMap((l) => l.cars);
            const stoppedCars = liveCars.filter((c) => c.stoppedNow);
            const recent = state.stats.recentClears;

            const queues = {};
            for (const info of this.nodeInfosByArterial.get(arterial.id) ?? []) {
                queues[info.node.id] = this._groundTruthQueue(info, liveCars);
            }

            stats[arterial.id] = {
                onRoad: liveCars.length,
                avgWaitNow: stoppedCars.length
                    ? stoppedCars.reduce((s, c) => s + c.totalWaitS, 0) / stoppedCars.length
                    : 0,
                avgWaitRolling: recent.length ? recent.reduce((s, c) => s + c.waitS, 0) / recent.length : 0,
                throughputPerMin: recent.length,
                clearedTotal: state.stats.clearedTotal,
                clearedWithoutStopTotal: state.stats.clearedWithoutStopTotal,
                clearedWithoutStopPct: state.stats.clearedTotal
                    ? (state.stats.clearedWithoutStopTotal / state.stats.clearedTotal) * 100
                    : null,
                queues,
                clearedByNode: state.stats.clearedByNode,
                chartSamples: state.chartSamples,
            };
        }

        return {
            simTimeS: this.simTimeS,
            powerState: this.powerState,
            cars,
            signals,
            stats,
            sensorAvailable: sensorAvailable(this.sensorMode, this.powerState, this.batteryBackedSensors),
        };
    }

    /**
     * Verification pass (build step 14): cars spawned minus cars cleared should
     * equal cars currently on the road, network-wide (arterials + connectors).
     * Diverting a car onto a connector is a transfer, not a spawn/clear, so it
     * never touches these counters - see _divertCarToConnector().
     */
    carAccounting() {
        const onRoadArterials = [...this.arterialState.values()].reduce(
            (n, s) => n + s.lanes.reduce((m, l) => m + l.cars.length, 0),
            0
        );
        const onRoadConnectors = [...this.connectorState.values()].reduce(
            (n, s) => n + s.fwd.lanes.reduce((m, l) => m + l.cars.length, 0) + s.rev.lanes.reduce((m, l) => m + l.cars.length, 0),
            0
        );
        const onRoadNetwork = onRoadArterials + onRoadConnectors;
        return {
            totalSpawned: this.accounting.totalSpawned,
            totalClearedNetwork: this.accounting.totalClearedNetwork,
            onRoadNetwork,
            balanced: this.accounting.totalSpawned === this.accounting.totalClearedNetwork + onRoadNetwork,
        };
    }

    /* ------------------------------------------------------------- internals */

    _arterialDemand(arterialId) {
        const s = this.arterialState.get(arterialId);
        return { spawnRatePerLanePerMin: s.spawnRatePerLanePerMin, saturationFlowPerLanePerHour: s.saturationFlowPerLanePerHour };
    }

    _crossDemandFor(node) {
        if (!node.connectorId) return null; // a bare cross-street stub carries no configured demand
        const connector = this.connectorsById.get(node.connectorId);
        return connector
            ? { spawnRatePerLanePerMin: connector.demand.spawnRatePerLanePerMin, saturationFlowPerLanePerHour: connector.demand.saturationFlowPerLanePerHour }
            : null;
    }

    _computePowerState() {
        if (this.power.manual) return 'load_shedding';
        if (this.power.scheduled) {
            const periodS = Math.max(1, this.power.periodMinutes) * 60;
            const offS = Math.max(0, this.power.offMinutes) * 60;
            if (this.simTimeS % periodS < offS) return 'load_shedding';
        }
        return 'normal';
    }

    _syncPowerState() {
        const next = this._computePowerState();
        if (next !== this.powerState) {
            this.powerState = next;
            this._rebuildAllControllers();
        }
    }

    _rebuildAllControllers() {
        for (const arterial of this.layout.arterials) {
            this._rebuildControllersForArterial(arterial.id);
        }
    }

    /** Mode or power-state change: every node on this arterial gets a fresh controller. */
    _rebuildControllersForArterial(arterialId) {
        const state = this.arterialState.get(arterialId);
        const nodeInfos = this.nodeInfosByArterial.get(arterialId) ?? [];

        if (this.powerState !== 'load_shedding' && state.mode === 'green_wave') {
            this._buildGreenWaveControllersFor(nodeInfos);
            return;
        }
        for (const info of nodeInfos) this._rebuildController(info.node.id);
    }

    /**
     * Demand change: re-derive signal timing without discarding phase state
     * where that would be wasteful. Fixed-time recomputes in place (keeps
     * wherever it currently is in the cycle); green wave is stateless (time
     * modulo cycle, no memory) so a full rebuild costs nothing; adaptive/none/
     * all-way-stop don't depend on demand at all.
     */
    _recomputeTimingForArterial(arterialId) {
        const state = this.arterialState.get(arterialId);
        const nodeInfos = this.nodeInfosByArterial.get(arterialId) ?? [];

        if (this.powerState !== 'load_shedding' && state.mode === 'green_wave') {
            this._buildGreenWaveControllersFor(nodeInfos);
            return;
        }
        for (const info of nodeInfos) {
            if (info.controllerType === 'fixed') {
                info.controller.recompute(this._arterialDemand(arterialId), this._crossDemandFor(info.node));
            }
        }
    }

    _buildGreenWaveControllersFor(nodeInfos) {
        if (!nodeInfos.length) return;
        const arterial = nodeInfos[0].arterial;
        const targetSpeedMps = (arterial.targetSpeedKph ?? 50) / 3.6;
        const controllers = buildGreenWaveControllers(
            nodeInfos,
            this._arterialDemand(arterial.id),
            (node) => this._crossDemandFor(node),
            targetSpeedMps
        );
        for (const info of nodeInfos) {
            info.controllerType = 'greenWave';
            info.controller = controllers.get(info.node.id);
        }
    }

    _rebuildController(nodeId) {
        const info = this.nodesInfo.get(nodeId);
        const arterialState = this.arterialState.get(info.arterial.id);
        const crossDemand = this._crossDemandFor(info.node);

        if (this.powerState === 'load_shedding') {
            info.controllerType = 'allWayStop';
            info.controller = new AllWayStopController();
        } else if (arterialState.mode === 'fixed') {
            info.controllerType = 'fixed';
            info.controller = new FixedTimeController(this._arterialDemand(info.arterial.id), crossDemand);
        } else if (arterialState.mode === 'adaptive') {
            info.controllerType = 'adaptive';
            info.controller = new AdaptiveController();
            info.callPersistenceS = [0, 0];
        } else {
            // Defensive fallback only - green_wave is intercepted one level up in
            // _rebuildControllersForArterial and never reaches here while power is
            // normal. Free-flow placeholder for any other/unknown mode value.
            info.controllerType = 'none';
            info.controller = { phase: 0, phaseState: 'green', isArterialGreen: () => true, isCrossGreen: () => true, tick: () => {} };
        }
    }

    _sampleArrival(spawnRatePerLanePerMin) {
        const lambdaPerSecond = Math.max(spawnRatePerLanePerMin, 0.01) / 60;
        return nextPoissonArrival(lambdaPerSecond, this.rng);
    }

    /**
     * The rate actually driving car arrivals right now. For a flat-demand
     * arterial/connector this is just its (possibly slider-adjusted)
     * `spawnRatePerLanePerMin`. For one with a configured fluctuation range
     * (corridor.js's `buildDemand()`), it's `fluctuatingDemand()` sampled at
     * the current sim time instead - deliberately NOT what fixedTime.js/
     * greenWave.js time their Webster plan to, so a fixed-time plan frozen
     * at the range's midpoint goes stale exactly like a real one would as
     * live conditions drift away from the historical count it was set from.
     */
    _liveSpawnRate(demand, designRatePerLanePerMin) {
        return demand.fluctuation ? fluctuatingDemand(this.simTimeS, demand.fluctuation) : designRatePerLanePerMin;
    }

    _spawnForArterial(arterial, dt) {
        const state = this.arterialState.get(arterial.id);
        const v0 = (arterial.targetSpeedKph ?? 50) / 3.6;

        state.lanes.forEach((lane, laneIndex) => {
            lane.timerS += dt;
            if (lane.timerS < lane.nextArrivalS) return;

            const nearestToEntry = lane.cars.reduce(
                (min, c) => (min === null || c.distanceM < min.distanceM ? c : min),
                null
            );
            if (nearestToEntry && nearestToEntry.distanceM < nearestToEntry.lengthM + SPAWN_CLEARANCE_M) {
                return; // no room yet - try again next tick without losing the elapsed timer
            }

            const vehicleType = this._rollVehicleType();
            const desiredSpeedMps = jitteredDesiredSpeed(v0 * VEHICLE_TYPES[vehicleType].desiredSpeedFactor, this.rng);
            lane.cars.push(
                new Car({
                    road: state.road,
                    lane: laneIndex,
                    distanceM: 0,
                    speedMps: desiredSpeedMps,
                    desiredSpeedMps,
                    colourIndex: Math.floor(this.rng.next() * CAR_PALETTE_SIZE),
                    startupDelayS: this.rng.next() * MAX_STARTUP_DELAY_S,
                    vehicleType,
                })
            );
            this.accounting.totalSpawned += 1;
            lane.timerS = 0;
            lane.nextArrivalS = this._sampleArrival(this._liveSpawnRate(arterial.demand, state.spawnRatePerLanePerMin));
        });
    }

    _stepArterialCars(arterial, dt) {
        const state = this.arterialState.get(arterial.id);
        const nodeInfos = this.nodeInfosByArterial.get(arterial.id) ?? [];

        for (const lane of state.lanes) {
            lane.cars.sort((a, b) => b.distanceM - a.distanceM); // front of the queue first

            // Cross-routing (build step 9) first, as its own pass - a car that
            // diverts this tick is removed here and never IDM-steps on the
            // arterial again, so the index-based "car ahead = previous index"
            // lookup below never has to account for a car vanishing mid-loop.
            lane.cars = lane.cars.filter((car) => !this._maybeCrossRoute(arterial, car, nodeInfos));
        }

        // MOBIL lane changes (equations.js) next, its own pass over the whole
        // arterial - a car needs visibility into every lane, not just its own,
        // to compare "what would my acceleration be here vs. next door", so
        // this can't be folded into the single-lane IDM loop below.
        if (state.lanes.length > 1) this._performLaneChanges(state, nodeInfos, dt);

        for (const lane of state.lanes) {
            lane.cars.sort((a, b) => b.distanceM - a.distanceM); // a lane change may have just reordered this lane

            for (let i = 0; i < lane.cars.length; i += 1) {
                const car = lane.cars[i];
                const realAhead = i > 0 ? lane.cars[i - 1] : null;
                const signalAhead = this._signalAheadFor(nodeInfos, car);
                const ahead = nearestAhead(realAhead, signalAhead);
                stepCar(car, ahead, dt);
                this._trackAllWayStopDwell(car, ahead, dt);
                this._recordNodeClears(state, nodeInfos, car);
            }

            while (lane.cars.length && lane.cars[0].distanceM > arterial.centrelineLengthM) {
                this._recordClear(arterial, lane.cars.shift());
            }
        }
    }

    /**
     * MOBIL lane changes (equations.js's mobilShouldChangeLane()) for one
     * tick across every lane of `arterial`. Snapshots each lane's car list up
     * front so every car is evaluated exactly once against the arrangement at
     * the start of the tick, regardless of what order lanes are visited in or
     * how many cars have already moved this tick.
     */
    _performLaneChanges(state, nodeInfos, dt) {
        const snapshotByLane = state.lanes.map((lane) => [...lane.cars]);

        for (const laneCars of snapshotByLane) {
            for (const car of laneCars) {
                if (car.turnAnim) continue; // mid cross-routing turn - cosmetic-only, not a real lane
                if (car.laneChangeCooldownS > 0) {
                    car.laneChangeCooldownS = Math.max(0, car.laneChangeCooldownS - dt);
                    continue;
                }
                this._tryChangeLane(state, nodeInfos, car);
            }
        }
    }

    /**
     * Evaluate (and, if favourable, perform) a MOBIL lane change for one car
     * into whichever adjacent lane offers the bigger acceleration gain -
     * "behind a slow car/truck, and a faster lane is safely available" is
     * exactly the case this falls out of, without special-casing trucks at
     * all: a truck's lower desired speed (car.js's VEHICLE_TYPES) is what
     * makes following it a worse `accSelfBefore` than changing lanes.
     */
    _tryChangeLane(state, nodeInfos, car) {
        if (car.distanceM < LANE_CHANGE_MIN_DISTANCE_M) return;
        const nearestNode = this._nearestNodeAhead(nodeInfos, car);
        if (nearestNode && nearestNode.stopLineDistanceM - car.distanceM < LANE_CHANGE_STOPLINE_EXCLUSION_M) return;

        const laneIndex = car.lane;
        const signalAhead = this._signalAheadFor(nodeInfos, car);
        const { leader: curLeader, follower: curFollower } = neighborsInLane(state.lanes[laneIndex].cars, car);
        const curAhead = nearestAhead(curLeader, signalAhead);
        const accSelfBefore = carAcceleration(car, curAhead);

        let best = null;
        for (const targetIndex of [laneIndex - 1, laneIndex + 1]) {
            if (targetIndex < 0 || targetIndex >= state.lanes.length) continue;
            const targetCars = state.lanes[targetIndex].cars;
            const { leader: tgtLeader, follower: tgtFollower } = neighborsInLane(targetCars, car);

            // Physical clearance check, on top of MOBIL's own acceleration-based
            // safety criterion below - stops a change that would leave two cars
            // visually overlapping even if the accelerations alone would allow it.
            const gapAheadM = tgtLeader ? tgtLeader.distanceM - tgtLeader.lengthM - car.distanceM : Infinity;
            const gapBehindM = tgtFollower ? car.distanceM - car.lengthM - tgtFollower.distanceM : Infinity;
            if (gapAheadM < MIN_LANE_CHANGE_GAP_M || gapBehindM < MIN_LANE_CHANGE_GAP_M) continue;

            const tgtLeaderAhead = nearestAhead(tgtLeader, signalAhead);
            const accSelfAfter = carAcceleration(car, tgtLeaderAhead);
            const accNewFollowerBefore = tgtFollower ? carAcceleration(tgtFollower, tgtLeaderAhead) : 0;
            const accNewFollowerAfter = tgtFollower ? carAcceleration(tgtFollower, car) : 0;
            const accOldFollowerBefore = curFollower ? carAcceleration(curFollower, car) : 0;
            const accOldFollowerAfter = curFollower ? carAcceleration(curFollower, curAhead) : 0;

            const shouldChange = mobilShouldChangeLane(
                {
                    accSelfBefore,
                    accSelfAfter,
                    accNewFollowerBefore,
                    accNewFollowerAfter,
                    accOldFollowerBefore,
                    accOldFollowerAfter,
                },
                car.mobilParams
            );
            if (!shouldChange) continue;

            const gain = accSelfAfter - accSelfBefore;
            if (!best || gain > best.gain) best = { targetIndex, gain };
        }

        if (!best) return;

        const fromCars = state.lanes[laneIndex].cars;
        fromCars.splice(fromCars.indexOf(car), 1);
        car.laneChangeAnim = { fromLane: laneIndex, elapsedS: 0 };
        car.lane = best.targetIndex;
        car.laneChangeCooldownS = LANE_CHANGE_COOLDOWN_S;
        const toCars = state.lanes[best.targetIndex].cars;
        toCars.push(car);
        toCars.sort((a, b) => b.distanceM - a.distanceM);
    }

    /** Native side-street arrivals (build step 9 gap) - separate from _maybeCrossRoute, which only diverts arterial cars onto a connector. */
    _spawnForConnector(connector, dt) {
        const state = this.connectorState.get(connector.id);
        const dirs = this.connectorDirs.get(connector.id);
        const v0 = CONNECTOR_TARGET_SPEED_KPH / 3.6;

        for (const dirKey of ['fwd', 'rev']) {
            const dir = dirs[dirKey];
            if (!dir.road.lanes) continue; // one-way connector's unused direction

            state[dirKey].lanes.forEach((lane, laneIndex) => {
                lane.timerS += dt;
                if (lane.timerS < lane.nextArrivalS) return;

                const nearestToEntry = lane.cars.reduce(
                    (min, c) => (min === null || c.distanceM < min.distanceM ? c : min),
                    null
                );
                if (nearestToEntry && nearestToEntry.distanceM < nearestToEntry.lengthM + SPAWN_CLEARANCE_M) {
                    return;
                }

                const vehicleType = this._rollVehicleType();
                const desiredSpeedMps = jitteredDesiredSpeed(v0 * VEHICLE_TYPES[vehicleType].desiredSpeedFactor, this.rng);
                lane.cars.push(
                    new Car({
                        road: dir.road,
                        lane: laneIndex,
                        distanceM: 0,
                        speedMps: desiredSpeedMps,
                        desiredSpeedMps,
                        colourIndex: Math.floor(this.rng.next() * CAR_PALETTE_SIZE),
                        startupDelayS: this.rng.next() * MAX_STARTUP_DELAY_S,
                        vehicleType,
                    })
                );
                this.accounting.totalSpawned += 1;
                lane.timerS = 0;
                lane.nextArrivalS = this._sampleArrival(this._liveSpawnRate(connector.demand, connector.demand.spawnRatePerLanePerMin));
            });
        }
    }

    _stepConnectorCars(connector, dt) {
        const state = this.connectorState.get(connector.id);
        const dirs = this.connectorDirs.get(connector.id);
        const routeLengthM = connector.spanM + connector.stubLengthM * 2; // stub tip to stub tip - matches renderer.js's drawn length

        for (const dirKey of ['fwd', 'rev']) {
            const dir = dirs[dirKey];
            const dirState = state[dirKey];
            if (!dir.road.lanes) continue; // one-way connector's unused direction

            const nearGateInfo = this.nodesInfo.get(dir.nearGateNode.id);
            const farGateInfo = this.nodesInfo.get(dir.gateNode.id);

            for (const lane of dirState.lanes) {
                lane.cars.sort((a, b) => b.distanceM - a.distanceM);

                for (let i = 0; i < lane.cars.length; i += 1) {
                    const car = lane.cars[i];
                    const realAhead = i > 0 ? lane.cars[i - 1] : null;
                    // A connector runs through two real intersections in sequence -
                    // check whichever one the car hasn't passed yet, nearest first.
                    const signalAhead =
                        this._connectorSignalAhead(nearGateInfo, dir.nearGateDistanceM, car) ??
                        this._connectorSignalAhead(farGateInfo, dir.gateDistanceM, car);
                    const ahead = nearestAhead(realAhead, signalAhead);
                    stepCar(car, ahead, dt);
                    this._trackAllWayStopDwell(car, ahead, dt);
                }

                while (lane.cars.length && lane.cars[0].distanceM > routeLengthM) {
                    lane.cars.shift();
                    this.accounting.totalClearedNetwork += 1;
                }
            }
        }
    }

    /** Shared by both arterial and connector stepping - the all-way-stop release rule only cares about the resolved `ahead`. */
    _trackAllWayStopDwell(car, ahead, dt) {
        if (!ahead?.isSignal || ahead.controllerType !== 'allWayStop') return;
        if (car.stoppedNow) {
            car.stopDwellS += dt;
            if (car.stopDwellS >= MIN_STOP_DWELL_S) car.releasedNodeId = ahead.nodeId;
        } else {
            car.stopDwellS = 0;
        }
    }

    /** Nearest node ahead of `car`, resolved to a virtual stationary obstacle if that node currently blocks the arterial. */
    _signalAheadFor(nodeInfos, car) {
        const nearest = this._nearestNodeAhead(nodeInfos, car);
        if (!nearest) return null;

        if (nearest.controllerType === 'allWayStop') {
            if (car.releasedNodeId === nearest.node.id) return null;
            return {
                distanceM: nearest.stopLineDistanceM,
                speedMps: 0,
                isSignal: true,
                nodeId: nearest.node.id,
                controllerType: 'allWayStop',
            };
        }

        if (!nearest.controller.isArterialGreen()) {
            return {
                distanceM: nearest.stopLineDistanceM,
                speedMps: 0,
                isSignal: true,
                nodeId: nearest.node.id,
                controllerType: nearest.controllerType,
            };
        }
        return null;
    }

    _nearestNodeAhead(nodeInfos, car) {
        let nearest = null;
        for (const info of nodeInfos) {
            if (info.stopLineDistanceM <= car.distanceM) continue;
            if (!nearest || info.stopLineDistanceM < nearest.stopLineDistanceM) nearest = info;
        }
        return nearest;
    }

    /** Resolves a single named gate (near or far linked node) to a virtual stationary obstacle if it currently blocks this car. */
    _connectorSignalAhead(gateInfo, gateDistanceM, car) {
        if (gateDistanceM <= car.distanceM) return null; // already past it, or entered past it (see _divertCarToConnector)

        if (gateInfo.controllerType === 'allWayStop') {
            if (car.releasedNodeId === gateInfo.node.id) return null;
            return { distanceM: gateDistanceM, speedMps: 0, isSignal: true, nodeId: gateInfo.node.id, controllerType: 'allWayStop' };
        }
        if (!gateInfo.controller.isCrossGreen()) {
            return { distanceM: gateDistanceM, speedMps: 0, isSignal: true, nodeId: gateInfo.node.id, controllerType: gateInfo.controllerType };
        }
        return null;
    }

    /**
     * Build step 9: once per (car, connector-bearing node), roll the dice on
     * whether this arterial car turns onto the cross street instead of
     * continuing straight. Only rolls once the car is right at a green stop
     * line (i.e. actually about to go through, not queued behind a red) so a
     * car stuck waiting doesn't burn through re-rolls every tick.
     *
     * @returns true if the car was removed from the arterial and handed off to
     * a connector lane (caller must drop it from its own array); false to
     * leave the car exactly where it is.
     */
    _maybeCrossRoute(arterial, car, nodeInfos) {
        if (car.lane !== 0) return false; // only the kerb (outer) lane can turn off the arterial
        const nearest = this._nearestNodeAhead(nodeInfos, car);
        if (!nearest || !nearest.node.connectorId) return false;
        if (car.crossRollNodeId === nearest.node.id) return false; // already decided for this node

        const distanceToStop = nearest.stopLineDistanceM - car.distanceM;
        if (distanceToStop > CROSS_DECISION_WINDOW_M) return false;
        if (nearest.controllerType === 'allWayStop' || !nearest.controller.isArterialGreen()) return false;

        car.crossRollNodeId = nearest.node.id;
        const connector = this.connectorsById.get(nearest.node.connectorId);
        if (!connector || this.rng.next() >= connector.crossChance) return false;

        return this._divertCarToConnector(car, nearest.node, connector);
    }

    _divertCarToConnector(car, node, connector) {
        const dirs = this.connectorDirs.get(connector.id);
        const isNodeA = connector.nodeIds[0] === node.id;
        let dirKey;
        let entryDistanceM;

        if (!connector.twoWay) {
            // A one-way street only accepts traffic entering at its own start
            // (node a) heading its one legal direction; turning onto it "against
            // the flow" from node b isn't a legal manoeuvre, so that car just
            // stays on the arterial instead.
            if (!isNodeA) return false;
            dirKey = 'fwd';
            entryDistanceM = connector.stubLengthM; // at node A, in fwd's frame
        } else {
            // Both branches resolve to the same two distances because a direction's
            // OWN node sits at stubLengthM in its frame and the gate (other) node
            // sits at stubLengthM + spanM, regardless of which physical node the
            // car is turning at - see the connectorDirs comment in the constructor.
            const towardOtherNode = this.rng.next() < 0.5;
            const atOwnNode = connector.stubLengthM;
            const atGateNode = connector.stubLengthM + connector.spanM;
            if (isNodeA) {
                dirKey = towardOtherNode ? 'fwd' : 'rev';
                entryDistanceM = towardOtherNode ? atOwnNode : atGateNode;
            } else {
                dirKey = towardOtherNode ? 'rev' : 'fwd';
                entryDistanceM = towardOtherNode ? atOwnNode : atGateNode;
            }
        }

        const dir = dirs[dirKey];
        const dirState = this.connectorState.get(connector.id)[dirKey];
        if (!dir.road.lanes) return false;

        const laneIndex = Math.floor(this.rng.next() * dir.road.lanes);
        const lane = dirState.lanes[laneIndex];
        const blocked = lane.cars.some(
            (c) => Math.abs(c.distanceM - entryDistanceM) < c.lengthM + SPAWN_CLEARANCE_M
        );
        if (blocked) return false; // no gap to turn into - the driver just continues straight

        lane.cars.push(
            new Car({
                road: dir.road,
                lane: laneIndex,
                distanceM: entryDistanceM,
                speedMps: car.speedMps, // carries its momentum through the turn
                desiredSpeedMps: jitteredDesiredSpeed(
                    (CONNECTOR_TARGET_SPEED_KPH / 3.6) * VEHICLE_TYPES[car.vehicleType].desiredSpeedFactor,
                    this.rng
                ),
                colourIndex: car.colourIndex,
                startupDelayS: this.rng.next() * MAX_STARTUP_DELAY_S,
                vehicleType: car.vehicleType, // a truck turning off the arterial stays a truck
                // Sweep the render from where the car was on the arterial, bowing
                // through the actual intersection corner, to its new connector
                // position/heading - instead of teleporting or cutting a straight
                // line across whatever lanes sit between the two.
                turnAnim: {
                    fromPoint: carWorldPoint(car),
                    fromHeading: car.road.heading,
                    controlPoint: node.point,
                    elapsedS: 0,
                },
            })
        );
        return true;
    }

    /** Stop-line detector for gap-out timing - independent of `sensorMode`, see sensors.js's detectPresenceAtStopLine(). */
    _vehicleDetectedAtStopLine(info, phase) {
        if (phase === 0) {
            const cars = this.arterialState.get(info.arterial.id).lanes.flatMap((l) => l.cars);
            return detectPresenceAtStopLine(cars, info.stopLineDistanceM);
        }
        const approaches = this._connectorApproach(info.node);
        if (!approaches) return false;
        return approaches.some((a) => detectPresenceAtStopLine(a.cars, a.gateDistanceM));
    }

    /**
     * Is the phase that would receive the next green already worth taking green away for?
     * `inductive_loop`/`magnetometer` have detection windows too short to ever count up to
     * `minCallToSwitch` real vehicles (8m/15m holds maybe 1-3 car lengths) - counting is simply
     * not a capability those sensors have, so instead of a threshold that can never trip, a call
     * just has to persist for `callDebounceS` uninterrupted seconds to count as sufficient. Wider
     * sensors (radar/camera) keep the original queue-depth threshold, which they can actually see.
     */
    _isOtherCallSufficient(info, currentPhase, dt) {
        const otherPhase = 1 - currentPhase;
        if (this.sensorMode === 'inductive_loop' || this.sensorMode === 'magnetometer') {
            info.callPersistenceS[currentPhase] = 0; // never "waiting" on itself while it holds green
            const present = this._sensedQueueForApproach(info, otherPhase) > 0;
            info.callPersistenceS[otherPhase] = present ? info.callPersistenceS[otherPhase] + dt : 0;
            return info.callPersistenceS[otherPhase] >= info.controller.params.callDebounceS;
        }
        const queue = this._sensedQueueForApproach(info, otherPhase);
        return hasSufficientCall(queue, info.controller.params);
    }

    _sensedQueueForApproach(info, phase) {
        if (phase === 0) {
            const cars = this.arterialState.get(info.arterial.id).lanes.flatMap((l) => l.cars);
            return readQueueLength(cars, info.stopLineDistanceM, this.sensorMode, this.rng);
        }
        // Cross phase (build step 9): sense whatever connector traffic is
        // actually approaching this node, same as the arterial side. A node can
        // be BOTH directions' near gate and far gate at once (once for the
        // direction that starts near it, once for the direction arriving from
        // the far end), so both groups are summed rather than picking one.
        const approaches = this._connectorApproach(info.node);
        if (!approaches) return 0;
        return approaches.reduce(
            (sum, a) => sum + readQueueLength(a.cars, a.gateDistanceM, this.sensorMode, this.rng),
            0
        );
    }

    /** Connector cars currently approaching `node` along its cross street (one entry per direction that reaches it), or null if this node has none. */
    _connectorApproach(node) {
        if (!node.connectorId) return null;
        const connector = this.connectorsById.get(node.connectorId);
        if (!connector) return null;
        const dirs = this.connectorDirs.get(connector.id);
        const state = this.connectorState.get(connector.id);

        const approaches = [];
        for (const dirKey of ['fwd', 'rev']) {
            const dir = dirs[dirKey];
            if (!dir.road.lanes) continue; // one-way connector's unused direction
            const cars = state[dirKey].lanes.flatMap((l) => l.cars);
            if (dir.nearGateNode.id === node.id) approaches.push({ cars, gateDistanceM: dir.nearGateDistanceM });
            else if (dir.gateNode.id === node.id) approaches.push({ cars, gateDistanceM: dir.gateDistanceM });
        }
        return approaches.length ? approaches : null;
    }

    _groundTruthQueue(info, liveCars) {
        return this._countQueued(liveCars, info.stopLineDistanceM);
    }

    _countQueued(cars, stopLineDistanceM) {
        let n = 0;
        for (const car of cars) {
            const d = stopLineDistanceM - car.distanceM;
            if (car.stoppedNow && d >= 0 && d <= QUEUE_WINDOW_M) n += 1;
        }
        return n;
    }

    /**
     * Ground-truth (never RNG-touching) read of everything the hover tooltip
     * shows - unlike `_sensedQueueForApproach()`, safe to call on every mouse
     * move without perturbing the seeded run (radar's noise draws from `rng`).
     */
    signalDebugInfo(nodeId) {
        const info = this.nodesInfo.get(nodeId);
        if (!info) return null;

        const arterialCars = this.arterialState.get(info.arterial.id).lanes.flatMap((l) => l.cars);
        const arterialQueue = this._groundTruthQueue(info, arterialCars);

        const approaches = this._connectorApproach(info.node);
        const crossQueue = approaches
            ? approaches.reduce((sum, a) => sum + this._countQueued(a.cars, a.gateDistanceM), 0)
            : 0;

        const controller = info.controller;
        const base = { controllerType: info.controllerType, arterialQueue, crossQueue };

        if (info.controllerType === 'allWayStop') {
            return { ...base, phaseLabel: 'Stop-controlled (load shedding)', elapsedS: null, etaLabel: 'per-car, ~2s dwell then release' };
        }
        if (info.controllerType === 'none') {
            return { ...base, phaseLabel: 'Free flow', elapsedS: null, etaLabel: 'n/a' };
        }

        const phaseLabel =
            controller.phaseState === 'green'
                ? controller.phase === 0
                    ? 'Arterial green'
                    : 'Cross green'
                : controller.phaseState === 'yellow'
                  ? 'Yellow'
                  : 'All-red';

        return { ...base, phaseLabel, elapsedS: controller.phaseElapsed, etaLabel: this._signalEtaLabel(info, arterialQueue, crossQueue) };
    }

    _signalEtaLabel(info, arterialQueue, crossQueue) {
        const controller = info.controller;
        const { phase, phaseState, phaseElapsed } = controller;

        if (phaseState === 'yellow') return `${Math.max(0, YELLOW_S - phaseElapsed).toFixed(1)}s (yellow)`;
        if (phaseState === 'allRed') return `${Math.max(0, ALL_RED_S - phaseElapsed).toFixed(1)}s (all-red)`;

        if (info.controllerType === 'fixed' || info.controllerType === 'greenWave') {
            const duration = controller.greenDurations[phase];
            return `${Math.max(0, duration - phaseElapsed).toFixed(1)}s (fixed split)`;
        }

        if (info.controllerType === 'adaptive') {
            const { minGreen, maxGreen, gapOutS, minCallToSwitch, callDebounceS } = controller.params;
            const otherQueue = phase === 0 ? crossQueue : arterialQueue; // ground truth, for the human reading this
            const otherName = phase === 0 ? 'cross street' : 'arterial';
            const usesNarrowSensor = this.sensorMode === 'inductive_loop' || this.sensorMode === 'magnetometer';
            const gapRemaining = gapOutS - controller.secondsSinceLastDetection;

            if (phaseElapsed < minGreen) return `≥ ${(minGreen - phaseElapsed).toFixed(1)}s (holding minimum green)`;
            if (otherQueue === 0) return `resting - no call on ${otherName}`;
            if (usesNarrowSensor) {
                const persistedS = info.callPersistenceS[1 - phase];
                if (persistedS < callDebounceS)
                    return `≤ ${(maxGreen - phaseElapsed).toFixed(1)}s (call on ${otherName} too new to trust - can't count depth on this sensor, capped by max green)`;
            } else if (otherQueue < minCallToSwitch) {
                return `≤ ${(maxGreen - phaseElapsed).toFixed(1)}s (small call on ${otherName}, capped by max green)`;
            }
            if (gapRemaining > 0) return `extending - vehicle detected ${controller.secondsSinceLastDetection.toFixed(1)}s ago (gaps out at ${gapOutS}s)`;
            return 'ending imminently';
        }

        return 'n/a';
    }

    /**
     * Per-node throughput, distinct from `_recordClear()`'s whole-arterial
     * count: a car that crosses an intersection's stop line has cleared that
     * road section even if it later turns off the arterial at a later node
     * (or never reaches the end). `nodeInfos` is ordered along the arterial,
     * so a car only ever needs to check its next unpassed node, not all of
     * them, and a car diverted onto a connector before reaching a stop line
     * (see `_maybeCrossRoute`) never gets counted for that node.
     */
    _recordNodeClears(state, nodeInfos, car) {
        while (car.nextNodeIndex < nodeInfos.length && car.distanceM >= nodeInfos[car.nextNodeIndex].stopLineDistanceM) {
            state.stats.clearedByNode[nodeInfos[car.nextNodeIndex].node.id] += 1;
            car.nextNodeIndex += 1;
        }
    }

    _recordClear(arterial, car) {
        const state = this.arterialState.get(arterial.id);
        state.stats.clearedTotal += 1;
        this.accounting.totalClearedNetwork += 1;
        if (!car.everStopped) state.stats.clearedWithoutStopTotal += 1;
        state.stats.recentClears.push({ tS: this.simTimeS, waitS: car.totalWaitS });
    }

    _pruneRolling(state) {
        const cutoff = this.simTimeS - ROLLING_WINDOW_S;
        while (state.stats.recentClears.length && state.stats.recentClears[0].tS < cutoff) {
            state.stats.recentClears.shift();
        }
    }

    _sampleChart(dt) {
        for (const state of this.arterialState.values()) {
            state.chartAccumS += dt;
            if (state.chartAccumS < CHART_SAMPLE_INTERVAL_S) continue;
            state.chartAccumS -= CHART_SAMPLE_INTERVAL_S;

            // Cumulative and never trimmed - unlike the rolling wait/throughput
            // stats above, "cleared over time" should show the whole run, not
            // a 60s window that would make a full-corridor traversal (which can
            // take longer than 60s) look permanently flat.
            state.chartSamples.push(state.stats.clearedTotal);
        }
    }
}
