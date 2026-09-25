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
    lanePoint,
    buildTurnPath,
    turnCorner,
    carRenderPoint,
    carRenderHeading,
    carAcceleration,
    entrySpeedBehind,
    VEHICLE_TYPES,
    TRUCK_VEHICLE_TYPES,
} from './car.js';
import { nextPoissonArrival, fluctuatingDemand, hasSufficientCall, mobilShouldChangeLane, mobilIsSafe } from './equations.js';
import { FixedTimeController } from './controllers/fixedTime.js';
import { AdaptiveController } from './controllers/adaptive.js';
import {
    AllWayStopController,
    MIN_STOP_DWELL_S,
    STOP_DWELL_JITTER_S,
    junctionClearTimeS,
    RELEASE_HESITATION_MIN_S,
    RELEASE_HESITATION_JITTER_S,
} from './controllers/allWayStop.js';
import { buildGreenWaveControllers } from './controllers/greenWave.js';
import { carShapeFor } from './carShapes.js';
import { readQueueLength, detectPresenceAtStopLine, sensorAvailable } from './sensors.js';
import { roadPointAt, TURN_LANE_TAPER_M } from './corridor.js';

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
/** How close to the stop line a car commits to its planned movement (and a car still in the wrong lane gives up on it). */
const CROSS_DECISION_WINDOW_M = 5;
/** A turning car whose way onto the cross street is blocked holds at the stop line - for at most this long, then it carries straight on so a jammed side street can never lock the arterial. */
const MAX_TURN_WAIT_S = 30;
/**
 * Speed a car drives its turn at (km/h, scaled by the vehicle's desiredSpeedFactor
 * so trucks take it slower). A left turn in left-hand traffic is the tight kerbside
 * corner; a right turn sweeps the wider radius across the junction.
 */
const TURN_SPEED_KPH = { left: 18, right: 22 };
/**
 * A cross-street driver turning right (across the oncoming half of a two-way
 * street, left-hand traffic) waits until no oncoming vehicle would reach the
 * junction within this many seconds - a standard critical gap for an
 * opposed turn at a signalised junction.
 */
const ONCOMING_CRITICAL_GAP_S = 4.5;
/** Comfortable braking a driver plans on when slowing for a turn (m/s^2) - the approach speed limit follows v^2 = vTurn^2 + 2*b*d. */
const TURN_APPROACH_DECEL_MPS2 = 1.5;
/** Shortest straight run into and out of a turn's corner (m) - keeps even a kerbside left turn a real curve, not a pivot. */
const MIN_TURN_LEG_M = 4;
/** Sprite variety (build step 11) - must match renderer.js PALETTE.carPalette.length in both themes. */
const CAR_PALETTE_SIZE = 4;
/** Widest randomised driver reaction lag (seconds) before pulling away from a stop - see car.js:stepCar()'s startup gate. */
const MAX_STARTUP_DELAY_S = 0.8;
/** Per-car desired-speed jitter, as a fraction either side of the road's target speed - real drivers don't all pick the exact same cruising speed. */
const DESIRED_SPEED_JITTER = 0.08;

/**
 * Random-events mode (setRandomEvents()) - a just-for-fun overlay, never on in
 * batch runs. Its dice come from their own `eventRng`, so with it off not one
 * extra draw is taken from the main RNG and every run stays bit-identical.
 */
const EVENT_SEED_SALT = 0x9e3779b9;
/** Share of plain cars that spawn as the BMW / the Ranger instead (car.js's VEHICLE_TYPES). */
const BMW_SHARE = 0.02;
const RANGER_SHARE = 0.05;
/** Random tie-break (m/s^2) added to each of the BMW's lane-change options, so it weaves across every lane rather than ping-ponging between the first two. */
const BMW_WEAVE_JITTER_MPS2 = 0.5;
/** Mean and minimum distance (m) a taxi drives between pickups. */
const TAXI_PICKUP_MEAN_SPACING_M = 350;
const TAXI_PICKUP_MIN_SPACING_M = 60;
/** Taxi dwell at a pickup: at least this long, plus up to the jitter (s). */
const TAXI_PICKUP_MIN_DWELL_S = 6;
const TAXI_PICKUP_DWELL_JITTER_S = 12;
/** Deceleration a taxi plans its stop on - it picks a spot this far ahead, it doesn't stop dead. */
const TAXI_PICKUP_DECEL_MPS2 = 2;
/** Clear of the junctions either side of a pickup spot (m) - taxis don't stop on a stop line or in a junction's exit. */
const TAXI_PICKUP_JUNCTION_CLEARANCE_M = 30;

/** MOBIL (equations.js) is suppressed within this many metres of a car's own spawn point, so it doesn't immediately dart across lanes before it has settled into traffic. */
const LANE_CHANGE_MIN_DISTANCE_M = 15;
/** ...and within this many metres of the next stop line, so a car isn't still weaving lanes for speed right at the junction. Mandatory (turn-lane) changes are exempt. */
const LANE_CHANGE_STOPLINE_EXCLUSION_M = 20;
/** Minimum physical bumper-to-bumper clearance a lane change may leave, on top of MOBIL's own acceleration-based safety criterion - stops a change from ever visually overlapping two cars. */
const MIN_LANE_CHANGE_GAP_M = 2;
/** Seconds a car commits to a lane after changing before it's allowed to evaluate another one - stops unrealistic tick-by-tick weaving. */
const LANE_CHANGE_COOLDOWN_S = 4;
/** Shorter settle time between MANDATORY changes, so a car crossing several lanes towards its turn lane still gets there within a block. */
const MANDATORY_LANE_CHANGE_COOLDOWN_S = 1.5;
/**
 * Merging into a turn lane: a car that must change lanes but has a vehicle
 * alongside it in the target lane eases off (comfortable deceleration, down to
 * a crawl) so the gap opens behind that vehicle; if instead the
 * vehicle just behind in the target lane is too close, that driver eases off to
 * let it in. Without this, two cars at near-identical cruising speeds can run
 * side by side for a whole block and the turn is never reached.
 */
const MERGE_DROP_BACK_DECEL_MPS2 = -1.0;
const MERGE_DROP_BACK_MIN_SPEED_MPS = 3;
/**
 * A car still in a lane its planned movement isn't allowed from, crawling in
 * a queue this close to the stop line, gives up on the change and makes the
 * movement its lane is marked for instead - a driver trapped in a turn-only
 * lane turns. Waiting for a gap here would hold up the whole lane behind it.
 */
const MANDATORY_GIVE_UP_M = 40;

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
/** Lane indices whose lane use (one entry per lane, kerb first) allows `movement`. */
function lanesAllowing(laneUse, movement) {
    const lanes = [];
    laneUse.forEach((moves, i) => {
        if (moves.includes(movement)) lanes.push(i);
    });
    return lanes;
}

/**
 * Which lane a turn comes out in: turning lanes pair up with target lanes in
 * order - the kerb-most left-turn lane into the kerb lane, the next into the
 * lane beside it, and so on (right turns likewise from the median side). A
 * double turn lane therefore fills two lanes of the road it turns into. More
 * turning lanes than target lanes share the last one. Never into the target
 * road's own turn lanes - the result is one of its through lanes' slots.
 */
function turnTargetLane(laneUse, fromLane, movement, targetLayout) {
    const targetLaneCount = targetLayout.mainLanes;
    const turning = lanesAllowing(laneUse, movement);
    const index = Math.max(0, turning.indexOf(fromLane));
    if (movement === 'left') return targetLayout.kerbSlots + Math.min(index, targetLaneCount - 1);
    return targetLayout.kerbSlots + Math.max(0, targetLaneCount - 1 - (turning.length - 1 - index));
}

/*
 * Turn lanes (corridor.js's `turnLanes`). A road's cars live in lane SLOTS,
 * kerb first: one slot outside the kerb lane if any approach along the road
 * has a kerb-side turn lane, then the road's own through lanes, then one slot
 * past the median-side lane if any approach has a median-side turn lane. With
 * no turn lanes the slots are exactly the lanes, so nothing changes. A turn
 * lane slot only exists over its last `lengthM` before a stop line - cars
 * enter it there and turn out of it at the junction; nobody spawns in one.
 */

/** Lane use for a slot that has no turn lane at this approach - no movement allowed from it. */
const CLOSED_SLOT = Object.freeze([]);

/** Slot layout of one road (an arterial, or one direction of a connector) from the approaches along it. */
function buildLaneLayout(approaches, mainLanes) {
    const kerbSlots = approaches.some((a) => a.turnLanes?.left) ? 1 : 0;
    const medianSlots = approaches.some((a) => a.turnLanes?.right) ? 1 : 0;
    return { kerbSlots, mainLanes, slots: kerbSlots + mainLanes + medianSlots, turnLanes: [] };
}

/**
 * One approach's lane use by slot - the same per-lane arrays as
 * `approach.laneUse`/its turn lanes (the lane-arrow editor changes them in
 * place, so edits apply live), CLOSED_SLOT where this approach has no turn lane.
 * Also records where along the road each of its turn lanes exists.
 */
function attachApproachToLayout(laneLayout, approach, stopLineDistanceM) {
    const kerb = approach.turnLanes?.left;
    const median = approach.turnLanes?.right;
    const medianSlot = laneLayout.kerbSlots + laneLayout.mainLanes;
    // Open from the start of its taper, so a car can move over as the road widens.
    if (kerb) laneLayout.turnLanes.push({ slot: 0, startM: stopLineDistanceM - kerb.lengthM - TURN_LANE_TAPER_M, endM: stopLineDistanceM });
    if (median) laneLayout.turnLanes.push({ slot: medianSlot, startM: stopLineDistanceM - median.lengthM - TURN_LANE_TAPER_M, endM: stopLineDistanceM });
    return [
        ...(laneLayout.kerbSlots ? [kerb?.laneUse ?? CLOSED_SLOT] : []),
        ...approach.laneUse,
        ...(medianSlot < laneLayout.slots ? [median?.laneUse ?? CLOSED_SLOT] : []),
    ];
}

function isThroughSlot(laneLayout, slot) {
    return slot >= laneLayout.kerbSlots && slot < laneLayout.kerbSlots + laneLayout.mainLanes;
}

/** A through lane always exists; a turn-lane slot only where one of its turn lanes is, measured at a car's front bumper. */
function slotOpenAt(laneLayout, slot, distanceM) {
    if (slot < 0 || slot >= laneLayout.slots) return false;
    if (isThroughSlot(laneLayout, slot)) return true;
    return laneLayout.turnLanes.some((t) => t.slot === slot && distanceM >= t.startM && distanceM <= t.endM);
}

/** The through lane beside a turn-lane slot - where a car waits to get into it, and where it goes back to. */
function throughSlotBeside(laneLayout, slot) {
    return slot < laneLayout.kerbSlots ? laneLayout.kerbSlots : laneLayout.kerbSlots + laneLayout.mainLanes - 1;
}

/**
 * Lanes a car planning `movement` should head for right now. `allowed` is
 * every slot whose lane use allows it; `target` is where the car should be:
 * with no turn lane involved that's `allowed` itself. Where the movement can
 * be made from a turn lane, the car moves into it once it's alongside, and
 * until then may wait in the through lane beside it.
 */
function laneTargets(laneLayout, slotLaneUse, movement, distanceM) {
    const allowed = lanesAllowing(slotLaneUse, movement);
    const turnSlots = allowed.filter((slot) => !isThroughSlot(laneLayout, slot));
    if (!turnSlots.length) return { allowed, target: allowed };
    const open = turnSlots.filter((slot) => slotOpenAt(laneLayout, slot, distanceM));
    if (open.length) return { allowed, target: open };
    const through = allowed.filter((slot) => isThroughSlot(laneLayout, slot));
    return { allowed, target: [...new Set([...through, ...turnSlots.map((slot) => throughSlotBeside(laneLayout, slot))])] };
}

/** A lane's state for one run: through lanes draw their own arrivals, turn-lane slots never spawn. */
function makeLaneStates(laneLayout, sampleArrival) {
    return Array.from({ length: laneLayout.slots }, (_, slot) =>
        isThroughSlot(laneLayout, slot) ? { cars: [], timerS: 0, nextArrivalS: sampleArrival() } : { cars: [], isTurnLane: true }
    );
}

/** IDM desired-speed cap for a car braking comfortably to reach its turn at turning speed. */
function turnApproachSpeedLimit(car, movement, toStopM) {
    const vTurn = turnSpeedMps(car, movement);
    return Math.sqrt(vTurn * vTurn + 2 * TURN_APPROACH_DECEL_MPS2 * Math.max(0, toStopM));
}

/** Left or right, from the arterial heading into the connector direction - y points south, so a positive cross product is a turn to the right. */
function turnMovement(arterialHeading, exitHeading) {
    const cross = arterialHeading.x * exitHeading.y - arterialHeading.y * exitHeading.x;
    return cross > 0 ? 'right' : 'left';
}

/** Physical bumper clearance to both neighbours in a target lane - stops a change from ever visually overlapping two cars. */
function hasClearanceAhead(car, leader) {
    return !leader || leader.distanceM - leader.lengthM - car.distanceM >= MIN_LANE_CHANGE_GAP_M;
}

function hasClearanceBehind(car, follower) {
    return !follower || car.distanceM - car.lengthM - follower.distanceM >= MIN_LANE_CHANGE_GAP_M;
}

function hasLaneChangeClearance(car, leader, follower) {
    return hasClearanceAhead(car, leader) && hasClearanceBehind(car, follower);
}

/**
 * IDM cap for a car dropping back to merge: brake gently while moving. At a
 * crawl it carries on with its own lane instead of holding still - stopping
 * dead with open road ahead would block every car behind it in that lane.
 */
function mergeDropBackCap(car) {
    return car.speedMps > MERGE_DROP_BACK_MIN_SPEED_MPS ? MERGE_DROP_BACK_DECEL_MPS2 : Infinity;
}

/** Turning speed for `movement` for this vehicle (m/s). */
function turnSpeedMps(car, movement) {
    return (TURN_SPEED_KPH[movement] / 3.6) * VEHICLE_TYPES[car.vehicleType].desiredSpeedFactor;
}

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
        this.arterialLaneLayouts = new Map(); // arterialId -> lane slot layout (turn lanes)
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
        /** Fraction (0-1) of newly-spawned vehicles that are buses - see setBusRatio()/_rollVehicleType(). */
        this.busRatio = 0;
        /** Random-events mode - see EVENT_SEED_SALT above and setRandomEvents(). */
        this.randomEvents = false;
        this.eventRng = new SeededRandom(1);
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

            const approaches = infos.map((info) => info.node.approaches.find((a) => a.kind === 'arterial'));
            const laneLayout = buildLaneLayout(approaches, arterial.lanes);
            infos.forEach((info, i) => {
                /** Lane use by lane slot (turn lanes included) - what every lookup by `car.lane` reads. */
                info.slotLaneUse = attachApproachToLayout(laneLayout, approaches[i], info.stopLineDistanceM);
            });
            this.arterialLaneLayouts.set(arterial.id, laneLayout);
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

        // Turns available at each connector-bearing node, fixed by geometry.
        this.turnOptionsByNode = new Map();
        for (const connector of layout.connectors) {
            for (const nodeId of connector.nodeIds) {
                this.turnOptionsByNode.set(nodeId, this._buildTurnOptions(this.nodesInfo.get(nodeId).node, connector));
            }
        }

        // Each connector direction's two junctions, in the order its cars reach
        // them, with the approach (lane use) and the turn onto that junction's
        // arterial - see _maybeTurnOffConnector().
        for (const connector of layout.connectors) {
            const dirs = this.connectorDirs.get(connector.id);
            for (const dirKey of ['fwd', 'rev']) {
                const dir = dirs[dirKey];
                dir.gates = [
                    this._buildGate(dir, dirKey, dir.nearGateNode, dir.nearGateDistanceM),
                    this._buildGate(dir, dirKey, dir.gateNode, dir.gateDistanceM),
                ];
                dir.laneLayout = buildLaneLayout(dir.gates.map((gate) => gate.approach).filter(Boolean), dir.road.lanes);
                for (const gate of dir.gates) {
                    gate.slotLaneUse = gate.approach ? attachApproachToLayout(dir.laneLayout, gate.approach, gate.stopLineDistanceM) : null;
                }
                dir.road.kerbSlots = dir.laneLayout.kerbSlots;
            }
        }
    }

    /**
     * One junction on a connector direction: its stop line in that direction's
     * frame, the cross approach there, and the one turn a car can make onto the
     * (one-way) arterial - left or right depending on which way the arterial runs.
     * It joins the arterial at the node, in that arterial's own frame.
     */
    _buildGate(dir, dirKey, node, stopLineDistanceM) {
        const info = this.nodesInfo.get(node.id);
        const approach = node.approaches.find((a) => a.kind === 'cross' && a.dirKey === dirKey) ?? null;
        const turnOption =
            approach && dir.road.lanes > 0
                ? {
                      arterialId: info.arterial.id,
                      movement: turnMovement(approach.heading, node.arterialHeading),
                      entryDistanceM: info.arterial.approachLengthM + node.sAlongM,
                  }
                : null;
        return { node, info, stopLineDistanceM, approach, turnOption };
    }

    /** Movements a lane on `approach` could physically make - straight, plus whichever turns the junction's geometry offers. The lane-arrow editor only offers markings made of these. */
    movementsAt(approach) {
        if (approach.kind === 'arterial') {
            return ['straight', ...(this.turnOptionsByNode.get(approach.nodeId) ?? []).map((o) => o.movement)];
        }
        const gate = this.connectorDirs.get(approach.connectorId)?.[approach.dirKey]?.gates.find((g) => g.node.id === approach.nodeId);
        return gate?.turnOption ? ['straight', gate.turnOption.movement] : ['straight'];
    }

    /**
     * Each connector direction an arterial car can turn into at `node`, with
     * where it enters that direction's frame. A direction's OWN node sits at
     * stubLengthM in its frame and the other node at stubLengthM + spanM (see
     * the connectorDirs comment above); a one-way connector only ever takes
     * its one legal direction - into the span at node a, or into the run-out
     * beyond node b.
     */
    _buildTurnOptions(node, connector) {
        const dirs = this.connectorDirs.get(connector.id);
        const isNodeA = connector.nodeIds[0] === node.id;
        const atOwnNode = connector.stubLengthM;
        const atGateNode = connector.stubLengthM + connector.spanM;

        let candidates;
        if (!connector.twoWay) {
            candidates = [{ dirKey: 'fwd', entryDistanceM: isNodeA ? atOwnNode : atGateNode }];
        } else if (isNodeA) {
            candidates = [
                { dirKey: 'fwd', entryDistanceM: atOwnNode },
                { dirKey: 'rev', entryDistanceM: atGateNode },
            ];
        } else {
            candidates = [
                { dirKey: 'rev', entryDistanceM: atOwnNode },
                { dirKey: 'fwd', entryDistanceM: atGateNode },
            ];
        }

        return candidates
            .filter((c) => dirs[c.dirKey].road.lanes > 0)
            .map((c) => ({ ...c, connectorId: connector.id, movement: turnMovement(node.arterialHeading, dirs[c.dirKey].road.heading) }));
    }

    /** Full restart: new seed, fresh cars, fresh stats. Also what the seed-determinism check (build step 12) needs. */
    reset({ seed, arterialModes, demand, sensorMode, batteryBackedSensors, power, truckRatio = 0, busRatio = 0, randomEvents = false }) {
        this.rng.reseed(seed);
        this.eventRng.reseed(seed ^ EVENT_SEED_SALT);
        this.randomEvents = randomEvents;
        resetCarIdCounter();
        this.simTimeS = 0;
        this.sensorMode = sensorMode;
        this.batteryBackedSensors = batteryBackedSensors;
        this.truckRatio = truckRatio;
        this.busRatio = busRatio;
        this.power = {
            manual: !!power.loadShedding,
            scheduled: !!power.scheduledOutages,
            offMinutes: power.offMinutes,
            periodMinutes: power.periodMinutes,
        };
        this.powerState = this._computePowerState();
        this.accounting = { totalSpawned: 0, totalClearedNetwork: 0 };
        /** Cars currently driving their turn through a junction - on neither the arterial nor the cross street yet (see _stepTurningCars()). */
        this.turningCars = [];
        // Combined side-street (all connectors) wait/throughput stats - one bucket, not
        // one per connector, since nothing downstream needs per-connector granularity.
        this.sideStreetStats = { clearedTotal: 0, clearedWithoutStopTotal: 0, waitSumTotal: 0, recentClears: [] };
        // Every completed vehicle's total wait, network-wide, in clear order - the raw
        // material for a full-run median/p95/max wait (see waitDistributionTotal()).
        this.allWaitTimesTotal = [];

        this.arterialState.clear();
        for (const arterial of this.layout.arterials) {
            const spawnRatePerLanePerMin = demand[arterial.id] ?? arterial.demand.spawnRatePerLanePerMin;
            const laneLayout = this.arterialLaneLayouts.get(arterial.id);
            this.arterialState.set(arterial.id, {
                laneLayout,
                mode: arterialModes[arterial.id] ?? arterial.mode,
                spawnRatePerLanePerMin,
                saturationFlowPerLanePerHour: arterial.demand.saturationFlowPerLanePerHour,
                road: {
                    heading: arterial.heading,
                    startPoint: arterial.startPoint,
                    roadWidthM: arterial.roadWidthM,
                    lanes: arterial.lanes,
                    laneWidthM: arterial.laneWidthM,
                    kerbSlots: laneLayout.kerbSlots,
                    // Set only for a curved arterial - see corridor.js's roadPointAt().
                    // curveOffsetM lines up this road's distanceM=0 (the approach
                    // lead-in's spawn point) with the curve's own t=0 (the first node).
                    curve: arterial.curve,
                    curveOffsetM: arterial.approachLengthM,
                },
                lanes: makeLaneStates(laneLayout, () => this._sampleArrival(this._liveSpawnRate(arterial.demand, spawnRatePerLanePerMin))),
                stats: {
                    clearedTotal: 0,
                    clearedWithoutStopTotal: 0,
                    // Cumulative, never pruned (unlike `recentClears`) - this is what lets
                    // buildSummary() in runHeadless.js compute a true full-run (or segment)
                    // average wait instead of a 60s-rolling-window snapshot.
                    waitSumTotal: 0,
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
            const makeDirState = (dir) => ({ laneLayout: dir.laneLayout, lanes: makeLaneStates(dir.laneLayout, () => this._sampleArrival(rate)) });
            this.connectorState.set(connector.id, {
                fwd: makeDirState(dirs.fwd),
                rev: makeDirState(dirs.rev),
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
            this._recomputeAllTiming();
            return;
        }

        const connector = this.connectorsById.get(id);
        if (!connector) return;
        connector.demand.spawnRatePerLanePerMin = ratePerLanePerMin;
        this._recomputeAllTiming();
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
            this._recomputeAllTiming();
            return;
        }

        const connector = this.connectorsById.get(id);
        if (!connector) return;
        connector.demand.fluctuation = { ...connector.demand.fluctuation, minPerLanePerMin, maxPerLanePerMin };
        connector.demand.spawnRatePerLanePerMin = midpoint;
        this._recomputeAllTiming();
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

    /**
     * Any demand change moves the planned flows at every junction - turning
     * traffic carries an arterial's demand onto the cross streets and from
     * there onto the other arterial - so every plan is re-derived.
     */
    _recomputeAllTiming() {
        for (const arterial of this.layout.arterials) this._recomputeTimingForArterial(arterial.id);
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

    /** Same as setTruckRatio(), for buses. */
    setBusRatio(ratio) {
        this.busRatio = Math.min(1, Math.max(0, ratio));
    }

    /**
     * Random events: a rare purple BMW that weaves at 20 over, Ranger double cabs
     * tailgating in the fastest lane, and the taxis (already on the road as a
     * body style) stopping in the kerb lane to pick people up. The BMW and Ranger
     * only come from new spawns, so switching this off lets them drain out; the
     * taxis stop pulling over straight away.
     */
    setRandomEvents(enabled) {
        this.randomEvents = !!enabled;
        if (this.randomEvents) return;
        for (const state of this.arterialState.values()) {
            for (const lane of state.lanes) {
                for (const car of lane.cars) car.pickup = null;
            }
        }
    }

    /**
     * Which vehicle type a newly-spawned car should be, per the truck- and bus-mix
     * sliders - trucks split evenly across TRUCK_VEHICLE_TYPES. Buses share the
     * truck roll's one draw (the band just above truckRatio) rather than drawing
     * their own, so with 0% buses the main RNG sequence - and so every batch run
     * and replay - is exactly what it was before buses existed.
     */
    _rollVehicleType() {
        const roll = this.rng.next();
        if (roll < this.truckRatio) return TRUCK_VEHICLE_TYPES[Math.floor(this.rng.next() * TRUCK_VEHICLE_TYPES.length)];
        if (roll < this.truckRatio + this.busRatio) return 'bus';
        return this.randomEvents ? this._rollEventCarType() : 'car';
    }

    /** Random events: a plain car's chance of being the BMW or the Ranger instead - from `eventRng`, never the main RNG. */
    _rollEventCarType() {
        const roll = this.eventRng.next();
        if (roll < BMW_SHARE) return 'bmw';
        if (roll < BMW_SHARE + RANGER_SHARE) return 'ranger';
        return 'car';
    }

    /** A new vehicle's cruising speed on a road with target speed `v0` (m/s) - the per-driver jitter, scaled by type, plus any random-events extra. */
    _desiredSpeedFor(vehicleType, v0) {
        const spec = VEHICLE_TYPES[vehicleType];
        return jitteredDesiredSpeed(v0 * spec.desiredSpeedFactor, this.rng) + (spec.extraSpeedKph ?? 0) / 3.6;
    }

    /** A minibus taxi that stops for passengers - one of the plain cars drawn with the taxi body style, only while random events are on. */
    _isPickupTaxi(car) {
        return this.randomEvents && car.vehicleType === 'car' && carShapeFor(car.id) === 'taxi';
    }

    /**
     * Zeroes every CUMULATIVE stats accumulator (clears, wait sums, the full-run wait
     * distribution) WITHOUT touching cars on the road, signal/queue state, RNG, or power state
     * - the standard traffic-sim warm-up technique: run the corridor from empty past its own
     * ramp-up transient first, then call this once to start measuring from an
     * already-equilibrated network instead of from a cold start. See runHeadless.js's
     * `warmupTicks`, which calls this right as the measured phase begins.
     *
     * Deliberately does NOT touch `recentClears` (the 60s rolling window `avgWaitRolling`/
     * `throughputPerMin` read from): that window is self-pruning and already reflects genuinely
     * equilibrated traffic the instant warm-up ends, so clearing it would just fabricate a fake
     * "corridor restarting from empty" dip in the rolling rate for the next 60s, on top of the
     * real one warm-up already spent ticks eliminating.
     *
     * A car already in transit at the moment this is called keeps whatever wait/stopped state
     * it accumulated during warm-up and carries it into its eventual (measured) clear - a minor,
     * standard edge effect at the warm-up boundary that only affects the handful of vehicles
     * mid-trip at that instant, not an ongoing bias.
     */
    resetStats() {
        for (const state of this.arterialState.values()) {
            state.stats.clearedTotal = 0;
            state.stats.clearedWithoutStopTotal = 0;
            state.stats.waitSumTotal = 0;
            for (const nodeId of Object.keys(state.stats.clearedByNode)) {
                state.stats.clearedByNode[nodeId] = 0;
            }
        }
        this.sideStreetStats.clearedTotal = 0;
        this.sideStreetStats.clearedWithoutStopTotal = 0;
        this.sideStreetStats.waitSumTotal = 0;
        this.allWaitTimesTotal = [];
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

        this._updateAllWayStopReleases();

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

        // After the cross streets, so a car that finishes its turn this tick isn't stepped twice.
        this._stepTurningCars(dt);

        for (const state of this.arterialState.values()) {
            this._pruneRolling(state.stats);
        }
        this._pruneRolling(this.sideStreetStats);

        this._sampleChart(dt);
    }

    /** Everything the render loop / stats footer needs for one frame (or one row of headless output). */
    snapshot() {
        const cars = [];
        for (const arterial of this.layout.arterials) {
            for (const lane of this.arterialState.get(arterial.id).lanes) {
                for (const car of lane.cars) {
                    cars.push({
                        id: car.id,
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
                            id: car.id,
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
        for (const car of this.turningCars) {
            cars.push({
                id: car.id,
                point: carRenderPoint(car),
                stopped: car.stoppedNow,
                heading: carRenderHeading(car),
                colourIndex: car.colourIndex,
                vehicleType: car.vehicleType,
                lengthM: car.lengthM,
                widthM: car.widthM,
            });
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
                waitSumTotal: state.stats.waitSumTotal,
                clearedWithoutStopTotal: state.stats.clearedWithoutStopTotal,
                clearedWithoutStopPct: state.stats.clearedTotal
                    ? (state.stats.clearedWithoutStopTotal / state.stats.clearedTotal) * 100
                    : null,
                queues,
                clearedByNode: state.stats.clearedByNode,
                chartSamples: state.chartSamples,
            };
        }

        const sideStreetRecent = this.sideStreetStats.recentClears;
        const sideStreet = {
            avgWaitRolling: sideStreetRecent.length
                ? sideStreetRecent.reduce((s, c) => s + c.waitS, 0) / sideStreetRecent.length
                : 0,
            throughputPerMin: sideStreetRecent.length,
            clearedTotal: this.sideStreetStats.clearedTotal,
            waitSumTotal: this.sideStreetStats.waitSumTotal,
            clearedWithoutStopTotal: this.sideStreetStats.clearedWithoutStopTotal,
            clearedWithoutStopPct: this.sideStreetStats.clearedTotal
                ? (this.sideStreetStats.clearedWithoutStopTotal / this.sideStreetStats.clearedTotal) * 100
                : null,
        };

        return {
            simTimeS: this.simTimeS,
            powerState: this.powerState,
            randomEvents: this.randomEvents,
            cars,
            signals,
            stats,
            sideStreet,
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
        const onRoadNetwork = onRoadArterials + onRoadConnectors + this.turningCars.length;
        return {
            totalSpawned: this.accounting.totalSpawned,
            totalClearedNetwork: this.accounting.totalClearedNetwork,
            onRoadNetwork,
            balanced: this.accounting.totalSpawned === this.accounting.totalClearedNetwork + onRoadNetwork,
        };
    }

    /* ------------------------------------------------------------- internals */

    /**
     * Webster input (fixedTime.js / greenWave.js) for the arterial phase at
     * `node`: the flow per lane actually arriving there, not just what enters
     * at the arterial's start - see _plannedApproachFlows(). Same
     * `{ spawnRatePerLanePerMin, saturationFlowPerLanePerHour }` shape the
     * controllers' flowRatio() reads, with the arriving flow as the rate.
     */
    _arterialDemandAt(node) {
        const info = this.nodesInfo.get(node.id);
        const s = this.arterialState.get(info.arterial.id);
        const flow = this._plannedApproachFlows().get(node.id);
        return { spawnRatePerLanePerMin: flow.arterialPerLanePerMin, saturationFlowPerLanePerHour: s.saturationFlowPerLanePerHour };
    }

    /** Webster input for the cross phase at `node`: its critical (busiest per lane) cross-street approach - see _plannedApproachFlows(). */
    _crossDemandFor(node) {
        if (!node.connectorId) return null; // a bare cross-street stub carries no configured demand
        const connector = this.connectorsById.get(node.connectorId);
        if (!connector) return null;
        const flow = this._plannedApproachFlows().get(node.id);
        return { spawnRatePerLanePerMin: flow.crossPerLanePerMin, saturationFlowPerLanePerHour: connector.demand.saturationFlowPerLanePerHour };
    }

    /**
     * The design flow (veh/min, per lane) arriving at each junction's arterial
     * and cross-street approaches - the q in Webster's y = q/s. Built from the
     * design spawn rates (the fluctuation midpoint, as before) plus the turning
     * the engine actually does: an arterial car turns off at a connector node
     * with `crossChance`, split evenly over the turns its lane use allows
     * (_rollTurnPlan()); a cross-street car turns onto the arterial with
     * `turnChance` (_rollConnectorTurnPlan()). So an arterial loses its
     * turners downstream and gains the side streets' turn-ins, and a
     * cross-street approach carries its own arrivals plus whatever turned in
     * off the arterial it just crossed. The arterials feed each other through
     * the connectors, so this is iterated to its fixed point (every turn share
     * is < 1, so it settles within a few passes).
     *
     * A phase's y is its critical lane group's (Webster 1958): the cross phase
     * serves both cross-street directions at once, so it takes the busier.
     */
    _plannedApproachFlows() {
        const arterialArrivals = new Map(); // nodeId -> veh/min arriving on the arterial approach (all lanes)
        const crossArrivals = new Map(); // `${nodeId}:${dirKey}` -> veh/min arriving on that cross approach

        for (let pass = 0; pass < 20; pass++) {
            const turnIns = new Map(); // `${connectorId}:${dirKey}` -> veh/min turning into that direction's span
            for (const arterial of this.layout.arterials) {
                let flow = arterial.lanes * this.arterialState.get(arterial.id).spawnRatePerLanePerMin;
                for (const info of this.nodeInfosByArterial.get(arterial.id) ?? []) {
                    const { node } = info;
                    arterialArrivals.set(node.id, flow);
                    const connector = node.connectorId ? this.connectorsById.get(node.connectorId) : null;
                    if (!connector) continue;

                    const options = (this.turnOptionsByNode.get(node.id) ?? []).filter((o) => lanesAllowing(info.slotLaneUse, o.movement).length);
                    const turningOff = options.length ? flow * connector.crossChance : 0;
                    for (const option of options) {
                        // Only a turn into the span reaches another junction - one into the near stub just leaves the map.
                        if (option.entryDistanceM !== connector.stubLengthM) continue;
                        const key = `${connector.id}:${option.dirKey}`;
                        turnIns.set(key, (turnIns.get(key) ?? 0) + turningOff / options.length);
                    }

                    let turningOn = 0;
                    for (const dirKey of ['fwd', 'rev']) {
                        const gate = this.connectorDirs.get(connector.id)[dirKey].gates.find((g) => g.node.id === node.id);
                        turningOn += (crossArrivals.get(`${node.id}:${dirKey}`) ?? 0) * this._plannedConnectorTurnShare(connector, gate);
                    }
                    flow = flow - turningOff + turningOn;
                }
            }

            for (const connector of this.layout.connectors) {
                for (const dirKey of ['fwd', 'rev']) {
                    const dir = this.connectorDirs.get(connector.id)[dirKey];
                    if (!dir.road.lanes) continue;
                    const [nearGate, farGate] = dir.gates;
                    const atNear = dir.road.lanes * connector.demand.spawnRatePerLanePerMin;
                    const atFar = atNear * (1 - this._plannedConnectorTurnShare(connector, nearGate)) + (turnIns.get(`${connector.id}:${dirKey}`) ?? 0);
                    crossArrivals.set(`${nearGate.node.id}:${dirKey}`, atNear);
                    crossArrivals.set(`${farGate.node.id}:${dirKey}`, atFar);
                }
            }
        }

        const flows = new Map();
        for (const [nodeId, arterialFlow] of arterialArrivals) {
            const info = this.nodesInfo.get(nodeId);
            const connector = info.node.connectorId ? this.connectorsById.get(info.node.connectorId) : null;
            let crossPerLanePerMin = 0;
            for (const dirKey of connector ? ['fwd', 'rev'] : []) {
                const lanes = this.connectorDirs.get(connector.id)[dirKey].road.lanes;
                if (lanes) crossPerLanePerMin = Math.max(crossPerLanePerMin, (crossArrivals.get(`${nodeId}:${dirKey}`) ?? 0) / lanes);
            }
            flows.set(nodeId, { arterialPerLanePerMin: arterialFlow / info.arterial.lanes, crossPerLanePerMin });
        }
        return flows;
    }

    /** Share of a cross-street approach's cars that turn onto the arterial at `gate` - `turnChance`, where its lane use allows the turn at all. */
    _plannedConnectorTurnShare(connector, gate) {
        const option = gate?.turnOption;
        if (!gate?.approach || !option || !lanesAllowing(gate.slotLaneUse, option.movement).length) return 0;
        return connector.turnChance;
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
                info.controller.recompute(this._arterialDemandAt(info.node), this._crossDemandFor(info.node));
            }
        }
    }

    _buildGreenWaveControllersFor(nodeInfos) {
        if (!nodeInfos.length) return;
        const arterial = nodeInfos[0].arterial;
        const targetSpeedMps = (arterial.targetSpeedKph ?? 50) / 3.6;
        const controllers = buildGreenWaveControllers(
            nodeInfos,
            (node) => this._arterialDemandAt(node),
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
            // Fresh outage, fresh junction - don't let a lock timestamp or an
            // approach's arrival clock from a previous load-shedding window
            // (simTimeS never resets mid-run) leak into this one.
            info.allWayStopLockedUntilS = 0;
            info.allWayStopLegs = {
                0: { arrivedAtS: null, requiredDwellS: null },
                1: { arrivedAtS: null, requiredDwellS: null },
            };
        } else if (arterialState.mode === 'fixed') {
            info.controllerType = 'fixed';
            info.controller = new FixedTimeController(this._arterialDemandAt(info.node), crossDemand);
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
            if (lane.isTurnLane) return;
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
            const desiredSpeedMps = this._desiredSpeedFor(vehicleType, v0);
            const car = new Car({
                road: state.road,
                lane: laneIndex,
                distanceM: 0,
                speedMps: desiredSpeedMps,
                desiredSpeedMps,
                colourIndex: Math.floor(this.rng.next() * CAR_PALETTE_SIZE),
                startupDelayS: this.rng.next() * MAX_STARTUP_DELAY_S,
                vehicleType,
            });
            car.speedMps = entrySpeedBehind(car, nearestToEntry);
            lane.cars.push(car);
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
        this._leaveClosedTurnLanes(state);

        for (const lane of state.lanes) {
            lane.cars.sort((a, b) => b.distanceM - a.distanceM); // a lane change may have just reordered this lane

            for (let i = 0; i < lane.cars.length; i += 1) {
                const car = lane.cars[i];
                const realAhead = i > 0 ? lane.cars[i - 1] : null;
                const signalAhead = this._signalAheadFor(nodeInfos, car);
                const pickupAhead = this._taxiPickupObstacle(arterial, nodeInfos, car, dt);
                const ahead = nearestAhead(nearestAhead(realAhead, signalAhead), pickupAhead);
                stepCar(car, ahead, dt, car.mergeDropBack ? mergeDropBackCap(car) : Infinity, this._turnApproachSpeedLimit(nodeInfos, car));
                car.mergeDropBack = false;
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
        if (car.pickup) return; // a taxi pulling over, or stopped for passengers, stays put
        const nearestNode = this._nearestNodeAhead(nodeInfos, car);
        const plan = nearestNode && car.turnPlan?.nodeId === nearestNode.node.id ? car.turnPlan : null;
        const lanes = plan ? laneTargets(state.laneLayout, nearestNode.slotLaneUse, plan.movement, car.distanceM) : null;

        if (lanes?.target.length && !lanes.target.includes(car.lane)) {
            const toStopM = nearestNode.stopLineDistanceM - car.distanceM;
            // Already in a lane that allows the movement, just not in the turn lane beside it: move over if there's room, never give up.
            const isInAllowedLane = lanes.allowed.includes(car.lane);
            if (!isInAllowedLane && toStopM < MANDATORY_GIVE_UP_M && car.speedMps < MERGE_DROP_BACK_MIN_SPEED_MPS) {
                const { node } = nearestNode;
                car.turnPlan = this._resolvePlanAtStopLine(car, node.id, nearestNode.slotLaneUse, this.turnOptionsByNode.get(node.id) ?? [], plan);
            } else if (toStopM > CROSS_DECISION_WINDOW_M) {
                this._tryMandatoryLaneChange(state, car, lanes.target, !isInAllowedLane);
            }
            return;
        }
        if (nearestNode && nearestNode.stopLineDistanceM - car.distanceM < LANE_CHANGE_STOPLINE_EXCLUSION_M) return;

        const allowedLanes = lanes?.target ?? null;
        const preferredLane = this._preferredLane(car, state.laneLayout);
        if (preferredLane !== null) {
            if (car.lane !== preferredLane) this._tryKeepToLane(state, car, preferredLane, allowedLanes);
            return;
        }

        const target = this._bestMobilLane(state, car, this._signalAheadFor(nodeInfos, car), allowedLanes);
        if (target !== null) this._moveToLane(state, car, target, VEHICLE_TYPES[car.vehicleType].laneChangeCooldownS ?? LANE_CHANGE_COOLDOWN_S);
    }

    /**
     * The adjacent lane (index) a MOBIL lane change should move `car` into -
     * whichever passes mobilShouldChangeLane() with the bigger acceleration
     * gain - or null to stay put. `state.lanes` must be sorted front-first; shared by
     * the arterials and the cross streets (`state` is an arterial's, or a connector direction's).
     */
    _bestMobilLane(state, car, signalAhead, allowedLanes = null) {
        const { lanes } = state;
        const laneIndex = car.lane;
        const { leader: curLeader, follower: curFollower } = neighborsInLane(lanes[laneIndex].cars, car);
        const curAhead = nearestAhead(curLeader, signalAhead);
        const accSelfBefore = carAcceleration(car, curAhead);

        let best = null;
        for (const targetIndex of [laneIndex - 1, laneIndex + 1]) {
            if (!slotOpenAt(state.laneLayout, targetIndex, car.distanceM)) continue;
            // A discretionary change never takes a car out of the lanes its planned movement is allowed from.
            if (allowedLanes && !allowedLanes.includes(targetIndex)) continue;
            const targetCars = lanes[targetIndex].cars;
            const { leader: tgtLeader, follower: tgtFollower } = neighborsInLane(targetCars, car);

            // Physical clearance check, on top of MOBIL's own acceleration-based
            // safety criterion below - stops a change that would leave two cars
            // visually overlapping even if the accelerations alone would allow it.
            if (!hasLaneChangeClearance(car, tgtLeader, tgtFollower)) continue;

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

            const weave = car.vehicleType === 'bmw' ? this.eventRng.next() * BMW_WEAVE_JITTER_MPS2 : 0;
            const gain = accSelfAfter - accSelfBefore + weave;
            if (!best || gain > best.gain) best = { targetIndex, gain };
        }

        return best?.targetIndex ?? null;
    }

    /** Random events: the lane a vehicle keeps to instead of choosing by MOBIL - the Ranger the fastest (outside) lane, a taxi the kerb lane. Null for everyone else. */
    _preferredLane(car, laneLayout) {
        if (car.vehicleType === 'ranger') return laneLayout.kerbSlots + laneLayout.mainLanes - 1;
        if (this._isPickupTaxi(car)) return laneLayout.kerbSlots;
        return null;
    }

    /** Steps one lane towards `preferredLane` when the gap is safe - no incentive test and no courtesy from the car behind, unlike a turn-lane merge. */
    _tryKeepToLane(state, car, preferredLane, allowedLanes) {
        const targetIndex = car.lane + Math.sign(preferredLane - car.lane);
        if (allowedLanes && !allowedLanes.includes(targetIndex)) return;
        const { leader, follower } = neighborsInLane(state.lanes[targetIndex].cars, car);
        if (!hasLaneChangeClearance(car, leader, follower)) return;
        if (follower && !mobilIsSafe(carAcceleration(follower, car), car.mobilParams)) return;
        this._moveToLane(state, car, targetIndex, MANDATORY_LANE_CHANGE_COOLDOWN_S);
    }

    /**
     * Random events: a taxi in the kerb lane pulls over every few hundred metres
     * to pick people up. Once it's due, it picks a spot it can brake for
     * comfortably - clear of the junctions either side - and that spot becomes
     * a stationary obstacle for this taxi alone, the same trick a red light
     * uses. It dwells there, then carries on. Cars behind it either queue or
     * find a gap next door through ordinary MOBIL.
     *
     * @returns the obstacle `{ distanceM, speedMps }` to stop at, or null.
     */
    _taxiPickupObstacle(arterial, nodeInfos, car, dt) {
        if (!this._isPickupTaxi(car)) return null;
        if (car.lane !== this.arterialLaneLayouts.get(arterial.id).kerbSlots) {
            car.pickup = null;
            return null;
        }
        if (car.pickup) return this._advanceTaxiPickup(car, dt);

        car.nextPickupM ??= car.distanceM + this._sampleTaxiPickupSpacingM();
        if (car.distanceM < car.nextPickupM) return null;

        const next = this._nearestNodeAhead(nodeInfos, car);
        if (next && car.turnPlan?.nodeId === next.node.id && car.turnPlan.option) {
            car.nextPickupM = next.stopLineDistanceM + TAXI_PICKUP_JUNCTION_CLEARANCE_M; // turning off soon - pick up after the junction
            return null;
        }
        const atM = car.distanceM + car.lengthM / 2 + (car.speedMps * car.speedMps) / (2 * TAXI_PICKUP_DECEL_MPS2) + car.idmParams.s0;
        if (next && atM > next.stopLineDistanceM - TAXI_PICKUP_JUNCTION_CLEARANCE_M) {
            car.nextPickupM = next.stopLineDistanceM + TAXI_PICKUP_JUNCTION_CLEARANCE_M;
            return null;
        }
        if (atM > arterial.centrelineLengthM - TAXI_PICKUP_JUNCTION_CLEARANCE_M) {
            car.nextPickupM = Infinity;
            return null;
        }

        car.pickup = { atM, dwellLeftS: null };
        return { distanceM: atM, speedMps: 0 };
    }

    _advanceTaxiPickup(car, dt) {
        const pickup = car.pickup;
        if (pickup.dwellLeftS === null) {
            const frontGapM = pickup.atM - (car.distanceM + car.lengthM / 2);
            if (car.stoppedNow && frontGapM <= car.idmParams.s0 + 1.5) {
                pickup.dwellLeftS = TAXI_PICKUP_MIN_DWELL_S + this.eventRng.next() * TAXI_PICKUP_DWELL_JITTER_S;
            }
        } else {
            pickup.dwellLeftS -= dt;
            if (pickup.dwellLeftS <= 0) {
                car.pickup = null;
                car.nextPickupM = car.distanceM + this._sampleTaxiPickupSpacingM();
                return null;
            }
        }
        return { distanceM: pickup.atM, speedMps: 0 };
    }

    /** Exponential spacing between one taxi's pickups, floored so it never stops twice in a row. */
    _sampleTaxiPickupSpacingM() {
        return TAXI_PICKUP_MIN_SPACING_M - Math.log(1 - this.eventRng.next()) * TAXI_PICKUP_MEAN_SPACING_M;
    }

    /**
     * A car whose planned movement isn't allowed from its current lane steps
     * one lane towards the nearest lane that allows it, as soon as the gap is
     * safe (mobilIsSafe - no incentive test, it has to change). A car that
     * still hasn't made it by the stop line gives up on the movement - see
     * _resolvePlanAtStopLine(). `isCourteous` false (a car that could make its
     * movement where it is, only moving into a turn lane) just waits for a gap -
     * nobody eases off to make one.
     */
    _tryMandatoryLaneChange(state, car, allowedLanes, isCourteous = true) {
        const nearestAllowed = allowedLanes.reduce((best, i) => (Math.abs(i - car.lane) < Math.abs(best - car.lane) ? i : best));
        const targetIndex = car.lane + Math.sign(nearestAllowed - car.lane);
        if (!slotOpenAt(state.laneLayout, targetIndex, car.distanceM)) return;
        const { leader, follower } = neighborsInLane(state.lanes[targetIndex].cars, car);
        if (!hasClearanceAhead(car, leader)) {
            if (isCourteous) car.mergeDropBack = true;
            return;
        }
        if (!hasClearanceBehind(car, follower) || (follower && !mobilIsSafe(carAcceleration(follower, car), car.mobilParams))) {
            if (isCourteous) follower.mergeDropBack = true; // the driver behind in that lane lets it in
            return;
        }
        this._moveToLane(state, car, targetIndex, MANDATORY_LANE_CHANGE_COOLDOWN_S);
    }

    /**
     * Safety net: a car still in a turn-lane slot where no turn lane exists any
     * more (it carried on past the stop line instead of turning) moves back
     * into the through lane beside it.
     */
    _leaveClosedTurnLanes(state) {
        state.lanes.forEach((lane, slot) => {
            if (!lane.isTurnLane) return;
            for (const car of lane.cars.filter((c) => !slotOpenAt(state.laneLayout, slot, c.distanceM))) {
                this._moveToLane(state, car, throughSlotBeside(state.laneLayout, slot), MANDATORY_LANE_CHANGE_COOLDOWN_S);
            }
        });
    }

    _moveToLane(state, car, targetIndex, cooldownS) {
        const fromCars = state.lanes[car.lane].cars;
        fromCars.splice(fromCars.indexOf(car), 1);
        car.laneChangeAnim = { fromLane: car.lane, elapsedS: 0 };
        car.lane = targetIndex;
        car.laneChangeCooldownS = cooldownS;
        const toCars = state.lanes[targetIndex].cars;
        toCars.push(car);
        toCars.sort((a, b) => b.distanceM - a.distanceM);
    }

    /** Native side-street arrivals (build step 9 gap) - separate from _maybeCrossRoute, which only diverts arterial cars onto a connector. */
    _spawnForConnector(connector, dt) {
        const state = this.connectorState.get(connector.id);
        const dirs = this.connectorDirs.get(connector.id);
        const v0 = connector.targetSpeedKph / 3.6;

        for (const dirKey of ['fwd', 'rev']) {
            const dir = dirs[dirKey];
            if (!dir.road.lanes) continue; // one-way connector's unused direction

            state[dirKey].lanes.forEach((lane, laneIndex) => {
                if (lane.isTurnLane) return;
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
                const desiredSpeedMps = this._desiredSpeedFor(vehicleType, v0);
                const car = new Car({
                    road: dir.road,
                    lane: laneIndex,
                    distanceM: 0,
                    speedMps: desiredSpeedMps,
                    desiredSpeedMps,
                    colourIndex: Math.floor(this.rng.next() * CAR_PALETTE_SIZE),
                    startupDelayS: this.rng.next() * MAX_STARTUP_DELAY_S,
                    vehicleType,
                });
                car.speedMps = entrySpeedBehind(car, nearestToEntry);
                lane.cars.push(car);
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

            // Turns onto the arterial first, as their own pass - same reason as
            // _stepArterialCars()'s cross-routing pass.
            for (const lane of dirState.lanes) {
                lane.cars.sort((a, b) => b.distanceM - a.distanceM);
                lane.cars = lane.cars.filter((car) => !this._maybeTurnOffConnector(connector, dir, dirKey, car));
            }
            if (dirState.lanes.length > 1) this._performConnectorLaneChanges(dir, dirState, dt);
            this._leaveClosedTurnLanes(dirState);

            for (const lane of dirState.lanes) {
                lane.cars.sort((a, b) => b.distanceM - a.distanceM);

                for (let i = 0; i < lane.cars.length; i += 1) {
                    const car = lane.cars[i];
                    const realAhead = i > 0 ? lane.cars[i - 1] : null;
                    const ahead = nearestAhead(realAhead, this._connectorObstacleAhead(dir, car));
                    stepCar(car, ahead, dt, car.mergeDropBack ? mergeDropBackCap(car) : Infinity, this._connectorTurnApproachSpeedLimit(dir, car));
                    car.mergeDropBack = false;
                }

                while (lane.cars.length && lane.cars[0].distanceM > routeLengthM) {
                    const car = lane.cars.shift();
                    this.accounting.totalClearedNetwork += 1;
                    this._recordSideStreetClear(car);
                }
            }
        }
    }

    /**
     * Lane changes on one direction of a cross street - the same rules as the
     * arterials (_tryChangeLane()): a car planning a turn at the next junction
     * works its way into a lane whose lane use allows it, and otherwise changes
     * lanes by MOBIL without leaving the lanes its planned movement is allowed from.
     */
    _performConnectorLaneChanges(dir, dirState, dt) {
        const snapshotByLane = dirState.lanes.map((lane) => [...lane.cars]);

        for (const laneCars of snapshotByLane) {
            for (const car of laneCars) {
                if (car.laneChangeCooldownS > 0) {
                    car.laneChangeCooldownS = Math.max(0, car.laneChangeCooldownS - dt);
                    continue;
                }
                if (car.distanceM < LANE_CHANGE_MIN_DISTANCE_M) continue;
                const gate = this._nextGate(dir, car);
                const plan = gate?.approach && car.turnPlan?.nodeId === gate.node.id ? car.turnPlan : null;
                const lanes = plan ? laneTargets(dirState.laneLayout, gate.slotLaneUse, plan.movement, car.distanceM) : null;

                if (lanes?.target.length && !lanes.target.includes(car.lane)) {
                    const toStopM = gate.stopLineDistanceM - car.distanceM;
                    const isInAllowedLane = lanes.allowed.includes(car.lane);
                    if (!isInAllowedLane && toStopM < MANDATORY_GIVE_UP_M && car.speedMps < MERGE_DROP_BACK_MIN_SPEED_MPS) {
                        car.turnPlan = this._resolvePlanAtStopLine(car, gate.node.id, gate.slotLaneUse, gate.turnOption ? [gate.turnOption] : [], plan);
                    } else if (toStopM > CROSS_DECISION_WINDOW_M) {
                        this._tryMandatoryLaneChange(dirState, car, lanes.target, !isInAllowedLane);
                    }
                    continue;
                }
                if (gate && gate.stopLineDistanceM - car.distanceM < LANE_CHANGE_STOPLINE_EXCLUSION_M) continue;

                const target = this._bestMobilLane(dirState, car, this._connectorObstacleAhead(dir, car), lanes?.target ?? null);
                if (target !== null) this._moveToLane(dirState, car, target, VEHICLE_TYPES[car.vehicleType].laneChangeCooldownS ?? LANE_CHANGE_COOLDOWN_S);
            }
        }
    }

    /** The next junction ahead of a car on connector direction `dir`, or null once it has passed both. */
    _nextGate(dir, car) {
        return dir.gates.find((gate) => gate.stopLineDistanceM > car.distanceM) ?? null;
    }

    /**
     * Whatever stops a connector car at a junction ahead: its own hold while
     * waiting to turn, or a signal/all-way stop. A connector runs through two
     * real intersections in sequence - a green at the near one still lets the
     * car see a red at the far one.
     */
    _connectorObstacleAhead(dir, car) {
        for (const gate of dir.gates) {
            if (gate.stopLineDistanceM <= car.distanceM) continue;
            if (car.turnPlan?.nodeId === gate.node.id && car.turnPlan.blockedSinceS != null) {
                return { distanceM: gate.stopLineDistanceM, speedMps: 0, isSignal: true, nodeId: gate.node.id, controllerType: gate.info.controllerType };
            }
            const obstacle = this._connectorSignalAhead(gate.info, gate.stopLineDistanceM, car);
            if (obstacle) return obstacle;
        }
        return null;
    }

    /** Same as _turnApproachSpeedLimit(), for a cross-street car turning onto the arterial. */
    _connectorTurnApproachSpeedLimit(dir, car) {
        const option = car.turnPlan?.option;
        if (!option) return Infinity;
        const gate = this._nextGate(dir, car);
        if (!gate || gate.node.id !== car.turnPlan.nodeId) return Infinity;
        return turnApproachSpeedLimit(car, option.movement, gate.stopLineDistanceM - car.distanceM);
    }

    /**
     * Cross-street turn planning and execution - the mirror of
     * _maybeCrossRoute(). As a junction becomes the next one ahead the car
     * decides whether to turn onto its arterial (the connector's `turnChance`,
     * if its approach's lane use allows that turn at all); at the stop line,
     * once allowed in, its lane decides, exactly as on the arterial.
     *
     * @returns true if the car left the connector (caller drops it from its lane).
     */
    _maybeTurnOffConnector(connector, dir, dirKey, car) {
        const gate = this._nextGate(dir, car);
        if (!gate?.approach) return false;
        const nodeId = gate.node.id;
        if (car.turnPlan?.nodeId !== nodeId) car.turnPlan = this._rollConnectorTurnPlan(connector, gate);
        if (car.crossRollNodeId === nodeId) return false;

        if (gate.stopLineDistanceM - car.distanceM > CROSS_DECISION_WINDOW_M) return false;
        const mayEnter = gate.info.controllerType === 'allWayStop' ? car.releasedNodeIds.has(nodeId) : gate.info.controller.isCrossGreen();
        if (!mayEnter) return false;

        car.turnPlan = this._resolvePlanAtStopLine(car, nodeId, gate.slotLaneUse, gate.turnOption ? [gate.turnOption] : [], car.turnPlan);
        if (!car.turnPlan.option) {
            car.crossRollNodeId = nodeId;
            return false;
        }
        if (this._divertCarToArterial(car, gate, connector, dirKey)) return true;

        this._holdForTurn(car, nodeId, isThroughSlot(dir.laneLayout, car.lane));
        return false;
    }

    _rollConnectorTurnPlan(connector, gate) {
        const straight = { nodeId: gate.node.id, movement: 'straight', option: null };
        const option = gate.turnOption;
        if (!option || !lanesAllowing(gate.slotLaneUse, option.movement).length) return straight;
        if (this.rng.next() >= connector.turnChance) return straight;
        return { nodeId: gate.node.id, movement: option.movement, option };
    }

    /**
     * Starts a cross-street car's turn onto the arterial - the mirror of
     * _divertCarToConnector(): a curved path through the junction into the
     * arterial lane its turning lane pairs with (turnTargetLane()). A
     * right turn off a two-way street crosses the oncoming half, so it also
     * waits for a gap in oncoming traffic.
     */
    _divertCarToArterial(car, gate, connector, dirKey) {
        const { node, turnOption } = gate;
        const arterial = gate.info.arterial;
        const state = this.arterialState.get(arterial.id);
        const laneIndex = turnTargetLane(gate.slotLaneUse, car.lane, turnOption.movement, state.laneLayout);
        const from = carWorldPoint(car);
        const fromHeading = roadPointAt(car.road, car.distanceM).heading;
        const exitDistanceM = this._turnExitDistance(from, fromHeading, state.road, laneIndex, turnOption.entryDistanceM + node.crossRoadWidthM / 2);
        const pathKey = `${node.id}:${connector.id}:${dirKey}->${arterial.id}:${laneIndex}`;

        const turnAhead = this.turningCars.some((c) => c.turnPath.key === pathKey && c.distanceM < (c.lengthM + car.lengthM) / 2 + SPAWN_CLEARANCE_M);
        if (turnAhead || this._turnExitBlocked(state.lanes, laneIndex, exitDistanceM, car.lengthM)) return false;
        if (turnOption.movement === 'right' && this._oncomingBlocksTurn(connector, dirKey, node)) return false;

        const exit = lanePoint(state.road, laneIndex, exitDistanceM);
        const path = buildTurnPath(from, fromHeading, exit.point, exit.heading);
        this.turningCars.push(
            new Car({
                id: car.id,
                road: state.road,
                lane: laneIndex,
                distanceM: 0, // along the turn path until it joins the lane
                speedMps: car.speedMps,
                desiredSpeedMps: this._desiredSpeedFor(car.vehicleType, arterial.targetSpeedKph / 3.6),
                colourIndex: car.colourIndex,
                startupDelayS: this.rng.next() * MAX_STARTUP_DELAY_S,
                vehicleType: car.vehicleType,
                turnPath: {
                    ...path,
                    key: pathKey,
                    arterialId: arterial.id,
                    exitDistanceM,
                    speedLimitMps: turnSpeedMps(car, turnOption.movement),
                },
            })
        );
        return true;
    }

    /**
     * True if an oncoming vehicle (the other direction of a two-way connector)
     * is in the junction or would reach it within ONCOMING_CRITICAL_GAP_S.
     * Oncoming right-turners don't conflict - in left-hand traffic the two
     * right turns pass each other.
     */
    _oncomingBlocksTurn(connector, dirKey, node) {
        const opposite = this.connectorDirs.get(connector.id)[dirKey === 'fwd' ? 'rev' : 'fwd'];
        if (!opposite.road.lanes) return false;
        const gate = opposite.gates.find((g) => g.node.id === node.id);
        const junctionDepthM = node.arterialRoadWidthM;

        for (const lane of this.connectorState.get(connector.id)[dirKey === 'fwd' ? 'rev' : 'fwd'].lanes) {
            for (const car of lane.cars) {
                if (car.turnPlan?.nodeId === node.id && car.turnPlan.movement === 'right') continue;
                const toStopM = gate.stopLineDistanceM - car.distanceM;
                if (toStopM < -junctionDepthM) continue; // already through the junction
                if (toStopM <= 0) return true; // in it now
                if (this._connectorSignalAhead(gate.info, gate.stopLineDistanceM, car)) continue; // held at its own red/stop line
                if (toStopM / Math.max(car.speedMps, 0.5) < ONCOMING_CRITICAL_GAP_S) return true;
            }
        }
        return false;
    }

    /**
     * Keeps one all-way-stop approach's (arterial or cross, at one node) own
     * arrival clock current: stamps `arrivedAtS` and rolls a fresh randomised
     * `requiredDwellS` (the shared "hesitation" - see MIN_STOP_DWELL_S/
     * STOP_DWELL_JITTER_S) the moment the approach goes from nobody queued to
     * somebody queued, and clears both the moment it drains back to empty so
     * the next arrival there starts a genuinely fresh clock. Deliberately
     * PER-APPROACH, not per-car: an earlier per-car version rolled each
     * lane's own hesitation independently, which meant four cars that all
     * stopped within the same instant would peel off in two separate
     * batches, whichever pair's random dwell happened to finish first -
     * visibly wrong, since none of those lanes conflict with each other and
     * a real driver waits for the CAR that's been sitting there, not a coin
     * flip for their own lane. One shared clock per approach means every
     * lane on the winning side releases together the moment that ONE clock
     * is up, matching "any number of lanes go together, gated by whoever's
     * actually been there longest."
     */
    _updateAllWayStopLegClock(info, legKey, hasQueue) {
        const legState = info.allWayStopLegs[legKey];
        if (hasQueue && legState.arrivedAtS === null) {
            legState.arrivedAtS = this.simTimeS;
            legState.requiredDwellS = MIN_STOP_DWELL_S + this.rng.next() * STOP_DWELL_JITTER_S;
        } else if (!hasQueue) {
            legState.arrivedAtS = null;
            legState.requiredDwellS = null;
        }
    }

    /**
     * Once per tick, decide which all-way-stop approach(es) - if any - get
     * released past each node: true first-come-first-served between the two
     * conflicting sides (arterial vs. cross - the same phase 0/1 convention
     * every other controller uses; a road's own lanes/directions don't
     * conflict with each other so they're one side each), by comparing which
     * side's arrival clock (`_updateAllWayStopLegClock` above) started
     * first, not a fixed turn order. A side only ever loses its priority
     * once it drains empty - a fixed "alternate every turn" rule let a
     * heavy-traffic side that merely refills faster win the race for a
     * freed lock again and again, forcing a light side to keep re-queueing
     * behind fresh arrivals and wait far longer than whoever's actually been
     * sitting there longest. If the longest-waiting side's own clock hasn't
     * finished yet, the lock is held idle rather than letting the other
     * side cut in - exactly the "first one at the stop line goes first"
     * rule of a real all-way stop. EVERY currently-queued lane on the
     * winning side releases together (any number of lanes), since same-side
     * traffic doesn't conflict with itself. The occupancy lock
     * (`allWayStopLockedUntilS`) is what actually stops the two conflicting
     * sides crossing the box at once - this only picks who's next once the
     * box is free. Reading queue state that's up to one tick stale (this
     * runs before this tick's car stepping) is harmless at dt-scale (~0.1s).
     */
    _updateAllWayStopReleases() {
        for (const info of this.nodesInfo.values()) {
            if (info.controllerType !== 'allWayStop') continue;

            const arterialQueued = this._allWayStopQueuedCars(info, 0);
            const crossQueued = this._allWayStopQueuedCars(info, 1);
            this._updateAllWayStopLegClock(info, 0, arterialQueued.length > 0);
            this._updateAllWayStopLegClock(info, 1, crossQueued.length > 0);

            if (this.simTimeS < (info.allWayStopLockedUntilS ?? 0)) continue;
            if (!arterialQueued.length && !crossQueued.length) continue;

            const arterialArrival = arterialQueued.length ? info.allWayStopLegs[0].arrivedAtS : Infinity;
            const crossArrival = crossQueued.length ? info.allWayStopLegs[1].arrivedAtS : Infinity;
            const legKey = arterialArrival <= crossArrival ? 0 : 1;
            const legState = info.allWayStopLegs[legKey];
            if (this.simTimeS - legState.arrivedAtS < legState.requiredDwellS) continue; // the longest-waiting side hasn't finished its own hesitation yet - hold, don't let the other side jump ahead

            const releasing = legKey === 0 ? arterialQueued : crossQueued;
            for (const car of releasing) {
                car.releasedNodeIds.add(info.node.id);
                car.startupDelayS = RELEASE_HESITATION_MIN_S + this.rng.next() * RELEASE_HESITATION_JITTER_S;
                car.startupTimerS = 0;
            }
            legState.arrivedAtS = null;
            legState.requiredDwellS = null;
            info.allWayStopLockedUntilS = this.simTimeS + junctionClearTimeS(info.node);
        }
    }

    /**
     * The one car per lane/direction (arterial `phase` 0, cross street
     * `phase` 1) currently at the TRUE front of its queue for `info.node`
     * specifically - i.e. the virtual all-way-stop obstacle, not a real car
     * ahead of it, is what it's actually braking for right now. Cars further
     * back in the same lane, still queued behind that front car, are
     * deliberately excluded: they're not yet independently blocked by this
     * node at all (a real car - the one ahead of them - is the nearer
     * obstacle), so they don't belong in this approach's release group yet
     * either; they join it themselves once they reach the front. The whole
     * group's shared hesitation clock lives on `info.allWayStopLegs`, not on
     * individual cars - see `_updateAllWayStopLegClock()`.
     */
    _allWayStopQueuedCars(info, phase) {
        const result = [];

        if (phase === 0) {
            const nodeInfos = this.nodeInfosByArterial.get(info.arterial.id) ?? [];
            const state = this.arterialState.get(info.arterial.id);
            for (const lane of state.lanes) {
                for (let i = 0; i < lane.cars.length; i += 1) {
                    const car = lane.cars[i];
                    if (!car.stoppedNow) continue;
                    // Same real-leader-vs-virtual-signal resolution _stepArterialCars()
                    // itself uses (lane.cars is front-first) - a car queued behind a
                    // REAL car ahead of it isn't yet the true front of the queue for
                    // this node, so it isn't counted as part of this approach yet.
                    const realAhead = i > 0 ? lane.cars[i - 1] : null;
                    const ahead = nearestAhead(realAhead, this._signalAheadFor(nodeInfos, car));
                    if (ahead?.isSignal && ahead.nodeId === info.node.id) result.push(car);
                }
            }
            return result;
        }

        if (!info.node.connectorId) return result;
        const connector = this.connectorsById.get(info.node.connectorId);
        if (!connector) return result;
        const dirs = this.connectorDirs.get(connector.id);
        const connState = this.connectorState.get(connector.id);
        for (const dirKey of ['fwd', 'rev']) {
            const dir = dirs[dirKey];
            if (!dir.road.lanes) continue;
            const nearGateInfo = this.nodesInfo.get(dir.nearGateNode.id);
            const farGateInfo = this.nodesInfo.get(dir.gateNode.id);
            for (const lane of connState[dirKey].lanes) {
                for (let i = 0; i < lane.cars.length; i += 1) {
                    const car = lane.cars[i];
                    if (!car.stoppedNow) continue;
                    const realAhead = i > 0 ? lane.cars[i - 1] : null;
                    const signalAhead =
                        this._connectorSignalAhead(nearGateInfo, dir.nearGateDistanceM, car) ??
                        this._connectorSignalAhead(farGateInfo, dir.gateDistanceM, car);
                    const ahead = nearestAhead(realAhead, signalAhead);
                    if (ahead?.isSignal && ahead.nodeId === info.node.id) result.push(car);
                }
            }
        }
        return result;
    }

    /** Nearest node ahead of `car`, resolved to a virtual stationary obstacle if that node currently blocks the arterial. */
    _signalAheadFor(nodeInfos, car) {
        const nearest = this._nearestNodeAhead(nodeInfos, car);
        if (!nearest) return null;

        // A car waiting for a gap to make its turn holds at the stop line whatever the signal shows.
        if (car.turnPlan?.nodeId === nearest.node.id && car.turnPlan.blockedSinceS != null) {
            return {
                distanceM: nearest.stopLineDistanceM,
                speedMps: 0,
                isSignal: true,
                nodeId: nearest.node.id,
                controllerType: nearest.controllerType,
            };
        }

        if (nearest.controllerType === 'allWayStop') {
            if (car.releasedNodeIds.has(nearest.node.id)) return null;
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
            if (car.releasedNodeIds.has(gateInfo.node.id)) return null;
            return { distanceM: gateDistanceM, speedMps: 0, isSignal: true, nodeId: gateInfo.node.id, controllerType: 'allWayStop' };
        }
        if (!gateInfo.controller.isCrossGreen()) {
            return { distanceM: gateDistanceM, speedMps: 0, isSignal: true, nodeId: gateInfo.node.id, controllerType: gateInfo.controllerType };
        }
        return null;
    }

    /**
     * Turn planning (turn lanes). The moment a node becomes the next one ahead,
     * the car picks its movement there: it turns with the connector's
     * `crossChance`, and picks uniformly among the turns the node's geometry
     * and lane use allow. _tryChangeLane() then works it into a lane that
     * allows that movement over the rest of the block.
     */
    _turnPlanFor(car, info) {
        if (car.turnPlan?.nodeId !== info.node.id) car.turnPlan = this._rollTurnPlan(info);
        return car.turnPlan;
    }

    _rollTurnPlan(info) {
        const { node } = info;
        const straight = { nodeId: node.id, movement: 'straight', option: null };
        const connector = node.connectorId ? this.connectorsById.get(node.connectorId) : null;
        if (!connector || this.rng.next() >= connector.crossChance) return straight;

        const options = (this.turnOptionsByNode.get(node.id) ?? []).filter((o) => lanesAllowing(info.slotLaneUse, o.movement).length);
        if (!options.length) return straight;
        const option = options.length === 1 ? options[0] : options[Math.floor(this.rng.next() * options.length)];
        return { nodeId: node.id, movement: option.movement, option };
    }

    /**
     * At the stop line a car's lane decides: a car that never reached a lane
     * for its planned movement makes one its lane does allow instead -
     * straight if it can, otherwise the turn its lane is marked for (the
     * "stuck in the turn-only lane" case).
     */
    _resolvePlanAtStopLine(car, nodeId, laneUse, turnOptions, plan) {
        const laneMoves = laneUse[car.lane];
        if (laneMoves.includes(plan.movement)) return plan;
        if (laneMoves.includes('straight')) return { nodeId, movement: 'straight', option: null };
        const option = turnOptions.find((o) => laneMoves.includes(o.movement));
        return option ? { nodeId, movement: option.movement, option } : { nodeId, movement: 'straight', option: null };
    }

    /**
     * Carries out a car's planned turn once it is right at the stop line and
     * allowed into the junction - a green, or its release at an all-way stop.
     *
     * @returns true if the car was removed from the arterial and handed off to
     * a connector lane (caller must drop it from its own array); false to
     * leave the car exactly where it is.
     */
    _maybeCrossRoute(arterial, car, nodeInfos) {
        const nearest = this._nearestNodeAhead(nodeInfos, car);
        if (!nearest) return false;
        const plan = this._turnPlanFor(car, nearest);
        if (car.crossRollNodeId === nearest.node.id) return false; // already committed at this node

        const distanceToStop = nearest.stopLineDistanceM - car.distanceM;
        if (distanceToStop > CROSS_DECISION_WINDOW_M) return false;
        const mayEnter =
            nearest.controllerType === 'allWayStop'
                ? car.releasedNodeIds.has(nearest.node.id)
                : nearest.controller.isArterialGreen();
        if (!mayEnter) return false;

        car.turnPlan = this._resolvePlanAtStopLine(car, nearest.node.id, nearest.slotLaneUse, this.turnOptionsByNode.get(nearest.node.id) ?? [], plan);
        if (!car.turnPlan.option) {
            car.crossRollNodeId = nearest.node.id;
            return false;
        }
        if (this._divertCarToConnector(car, nearest, car.turnPlan.option)) return true;

        // No gap on the cross street yet: wait at the stop line (see _signalAheadFor()) and retry next tick.
        this._holdForTurn(car, nearest.node.id, isThroughSlot(this.arterialLaneLayouts.get(arterial.id), car.lane));
        return false;
    }

    /**
     * A car whose turn is blocked holds at the stop line - for at most
     * MAX_TURN_WAIT_S, then carries straight on. One in a turn lane
     * (`canGoStraight` false) has nowhere straight to go, so it keeps waiting -
     * it only holds up the turn lane.
     */
    _holdForTurn(car, nodeId, canGoStraight = true) {
        car.turnPlan.blockedSinceS ??= this.simTimeS;
        if (canGoStraight && this.simTimeS - car.turnPlan.blockedSinceS >= MAX_TURN_WAIT_S) {
            car.crossRollNodeId = nodeId;
            car.turnPlan = { nodeId, movement: 'straight', option: null };
        }
    }

    /**
     * Starts the car's turn: it leaves the arterial here and drives a curved
     * path through the junction (car.js's buildTurnPath()) into the cross-street
     * lane its turning lane pairs with (turnTargetLane()) - a single left-turn
     * lane feeds the kerb lane. It joins that lane at the far edge of the junction; until
     * then it's in `turningCars` (see _stepTurningCars()).
     */
    _divertCarToConnector(car, info, { connectorId, dirKey, entryDistanceM, movement }) {
        const { node } = info;
        const dir = this.connectorDirs.get(connectorId)[dirKey];
        const laneIndex = turnTargetLane(info.slotLaneUse, car.lane, movement, dir.laneLayout);
        const from = carWorldPoint(car);
        const exitDistanceM = this._turnExitDistance(from, car.road.heading, dir.road, laneIndex, entryDistanceM + node.arterialRoadWidthM / 2);
        const pathKey = `${node.id}:${connectorId}:${dirKey}:${laneIndex}`;

        // Wait at the stop line while the car ahead on the same turn is still pulling away,
        // or the cross-street lane is occupied where this turn comes out.
        const turnAhead = this.turningCars.some((c) => c.turnPath.key === pathKey && c.distanceM < (c.lengthM + car.lengthM) / 2 + SPAWN_CLEARANCE_M);
        if (turnAhead || this._turnExitBlocked(this.connectorState.get(connectorId)[dirKey].lanes, laneIndex, exitDistanceM, car.lengthM)) return false;

        const exit = lanePoint(dir.road, laneIndex, exitDistanceM);
        const path = buildTurnPath(from, car.road.heading, exit.point, exit.heading);
        this.turningCars.push(
            new Car({
                id: car.id, // the same vehicle, so the renderers keep its shape and colour
                road: dir.road,
                lane: laneIndex,
                distanceM: 0, // along the turn path until it joins the lane
                speedMps: car.speedMps,
                desiredSpeedMps: this._desiredSpeedFor(car.vehicleType, this.connectorsById.get(connectorId).targetSpeedKph / 3.6),
                colourIndex: car.colourIndex,
                startupDelayS: this.rng.next() * MAX_STARTUP_DELAY_S,
                vehicleType: car.vehicleType, // a truck turning off the arterial stays a truck
                turnPath: {
                    ...path,
                    key: pathKey,
                    connectorId,
                    dirKey,
                    exitDistanceM,
                    speedLimitMps: turnSpeedMps(car, movement),
                },
            })
        );
        return true;
    }

    /**
     * Where along the cross-street lane a turn comes out: at least the far
     * edge of the junction, and far enough past the corner that the run out of
     * the corner matches the run into it (and MIN_TURN_LEG_M), so the curve is
     * a smooth, roughly circular sweep ending on the lane's own heading.
     */
    _turnExitDistance(from, fromHeading, road, laneIndex, junctionEdgeDistanceM) {
        const edge = lanePoint(road, laneIndex, junctionEdgeDistanceM);
        const corner = turnCorner(from, fromHeading, edge.point, edge.heading);
        const legInM = Math.hypot(corner.x - from.x, corner.y - from.y);
        const edgeBeyondCornerM = (edge.point.x - corner.x) * edge.heading.x + (edge.point.y - corner.y) * edge.heading.y;
        return junctionEdgeDistanceM + Math.max(0, Math.max(legInM, MIN_TURN_LEG_M) - edgeBeyondCornerM);
    }

    /** True if lane `laneIndex` of `lanes` (a connector direction's or an arterial's) has a vehicle too close to where a turn joins it. */
    _turnExitBlocked(lanes, laneIndex, exitDistanceM, lengthM) {
        return lanes[laneIndex].cars.some((c) => Math.abs(c.distanceM - exitDistanceM) < (c.lengthM + lengthM) / 2 + SPAWN_CLEARANCE_M);
    }

    /** The lanes a turning car is headed for - a connector direction's, or an arterial's for a car turning off a cross street. */
    _turnTargetLanes(path) {
        return path.arterialId ? this.arterialState.get(path.arterialId).lanes : this.connectorState.get(path.connectorId)[path.dirKey].lanes;
    }

    /**
     * Speed limit for an arterial car planning a turn at the next node: it
     * brakes comfortably so it reaches the stop line at turning speed.
     */
    _turnApproachSpeedLimit(nodeInfos, car) {
        const option = car.turnPlan?.option;
        if (!option) return Infinity;
        const nearest = this._nearestNodeAhead(nodeInfos, car);
        if (!nearest || nearest.node.id !== car.turnPlan.nodeId) return Infinity;
        return turnApproachSpeedLimit(car, option.movement, nearest.stopLineDistanceM - car.distanceM);
    }

    /**
     * Cars mid-turn, one IDM step each at turning speed, following the car
     * ahead on the same turn path; a car whose cross-street lane is backed up
     * waits at the end of the junction. At the end of its path a car joins its
     * cross-street lane, carrying on with any distance it overshot.
     */
    _stepTurningCars(dt) {
        if (!this.turningCars.length) return;
        this.turningCars.sort((a, b) => b.distanceM - a.distanceM);

        const leaderByKey = new Map();
        const stillTurning = [];
        for (const car of this.turningCars) {
            const path = car.turnPath;
            const targetLanes = this._turnTargetLanes(path);
            const exitBlocked = this._turnExitBlocked(targetLanes, car.lane, path.exitDistanceM, car.lengthM);
            const pathEnd = exitBlocked ? { distanceM: path.lengthM, speedMps: 0 } : null;
            const ahead = nearestAhead(leaderByKey.get(path.key) ?? null, pathEnd);
            stepCar(car, ahead, dt, Infinity, path.speedLimitMps);
            leaderByKey.set(path.key, car);

            if (car.distanceM < path.lengthM || exitBlocked) {
                stillTurning.push(car);
                continue;
            }
            const lane = targetLanes[car.lane];
            car.distanceM = path.exitDistanceM + (car.distanceM - path.lengthM);
            car.turnPath = null;
            if (path.arterialId) {
                // Joining an arterial partway along: only the stop lines still ahead count towards its per-node throughput.
                const infos = this.nodeInfosByArterial.get(path.arterialId);
                const next = infos.findIndex((info) => info.stopLineDistanceM > car.distanceM);
                car.nextNodeIndex = next === -1 ? infos.length : next;
            }
            lane.cars.push(car);
            lane.cars.sort((a, b) => b.distanceM - a.distanceM);
        }
        this.turningCars = stillTurning;
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
            return {
                ...base,
                phaseLabel: 'Stop-controlled (load shedding)',
                elapsedS: null,
                etaLabel: 'per-approach, ~2-4.5s hesitant dwell, one side clears the box at a time',
            };
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
        state.stats.waitSumTotal += car.totalWaitS;
        this.accounting.totalClearedNetwork += 1;
        if (!car.everStopped) state.stats.clearedWithoutStopTotal += 1;
        state.stats.recentClears.push({ tS: this.simTimeS, waitS: car.totalWaitS });
        this.allWaitTimesTotal.push(car.totalWaitS);
    }

    /** Same bookkeeping as `_recordClear()`, but into the single combined side-street bucket. */
    _recordSideStreetClear(car) {
        this.sideStreetStats.clearedTotal += 1;
        this.sideStreetStats.waitSumTotal += car.totalWaitS;
        if (!car.everStopped) this.sideStreetStats.clearedWithoutStopTotal += 1;
        this.sideStreetStats.recentClears.push({ tS: this.simTimeS, waitS: car.totalWaitS });
        this.allWaitTimesTotal.push(car.totalWaitS);
    }

    /**
     * Full-run, network-wide wait distribution - median/p95/max, computed once (not per
     * snapshot) from every vehicle that ever cleared, not just the last 60s rolling window
     * `snapshot()`'s avgWaitRolling uses. A single mean can't tell "everyone waits a bit
     * longer" apart from "most people are fine, a few are stranded" - this can.
     */
    waitDistributionTotal() {
        const waits = this.allWaitTimesTotal;
        if (!waits.length) return { medianWait: null, p95Wait: null, maxWait: null };

        const sorted = [...waits].sort((a, b) => a - b);
        const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        return {
            medianWait: percentile(0.5),
            p95Wait: percentile(0.95),
            maxWait: sorted[sorted.length - 1],
        };
    }

    _pruneRolling(stats) {
        const cutoff = this.simTimeS - ROLLING_WINDOW_S;
        while (stats.recentClears.length && stats.recentClears[0].tS < cutoff) {
            stats.recentClears.shift();
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
