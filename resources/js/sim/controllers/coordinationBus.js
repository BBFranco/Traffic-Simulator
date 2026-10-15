/**
 * controllers/coordinationBus.js - layer 2 of coordinated adaptive: junctions telling the next one along
 * what they have just released.
 *
 * Each vehicle that leaves a signal heading for the next signalised junction on the same carriageway
 * is posted to that junction with when it should arrive there (travelTimeS()). The receiving
 * controller only ever asks "how many are due in this window" - it never sees the cars themselves.
 *
 * Idealised on purpose, and the write-up has to say so: a message is exact and arrives at once. On the
 * street it would come from the upstream controller's exit or stop-line detectors over the signal
 * network (SCATS strategic detectors, ACS Lite, video), about a second late, with whatever counts the
 * detector misses or doubles. Deterministic - no RNG draws - so a run with the bus on differs from one
 * with it off only by what the controllers do with it.
 */

/** A message this long past its arrival time is dropped - the car is in the queue (local detection sees it) or went elsewhere. */
const STALE_AFTER_S = 2;

/**
 * Free-flow time to cover `distanceM` starting at `speedMps`: accelerate at `accelMps2` up to
 * `targetSpeedMps`, then cruise - the same start-from-rest idea as the green-wave offset lag.
 */
export function travelTimeS(distanceM, speedMps, targetSpeedMps, accelMps2) {
    const v0 = Math.min(Math.max(0, speedMps), targetSpeedMps);
    const accelDistM = (targetSpeedMps * targetSpeedMps - v0 * v0) / (2 * accelMps2);
    if (accelDistM >= distanceM) return (Math.sqrt(v0 * v0 + 2 * accelMps2 * distanceM) - v0) / accelMps2;
    return (targetSpeedMps - v0) / accelMps2 + (distanceM - accelDistM) / targetSpeedMps;
}

export class CoordinationBus {
    constructor() {
        /** nodeId -> Map<carId, arriveAtS> */
        this.inbox = new Map();
        this.posted = 0;
    }

    post(nodeId, carId, arriveAtS) {
        let box = this.inbox.get(nodeId);
        if (!box) this.inbox.set(nodeId, (box = new Map()));
        box.set(carId, arriveAtS);
        this.posted += 1;
    }

    /** The car reached the junction it was posted to - it is no longer on its way. */
    arrived(nodeId, carId) {
        this.inbox.get(nodeId)?.delete(carId);
    }

    expire(nowS) {
        for (const box of this.inbox.values()) {
            for (const [carId, arriveAtS] of box) if (arriveAtS < nowS - STALE_AFTER_S) box.delete(carId);
        }
    }

    /** Vehicles posted to `nodeId` due in [fromS, toS]. */
    countWithin(nodeId, fromS, toS) {
        const box = this.inbox.get(nodeId);
        if (!box) return 0;
        let n = 0;
        for (const arriveAtS of box.values()) if (arriveAtS >= fromS && arriveAtS <= toS) n += 1;
        return n;
    }

    /** The controller's view of its own inbox - `(fromS, toS) => vehicles`. */
    viewFor(nodeId) {
        return (fromS, toS) => this.countWithin(nodeId, fromS, toS);
    }

    /** Soonest arrival still to come at `nodeId` and how many are due within `windowS` of it - the tooltip's. */
    nextPlatoon(nodeId, nowS, windowS) {
        const box = this.inbox.get(nodeId);
        if (!box?.size) return null;
        let first = Infinity;
        for (const arriveAtS of box.values()) if (arriveAtS >= nowS && arriveAtS < first) first = arriveAtS;
        if (!Number.isFinite(first)) return null;
        return { inS: first - nowS, vehicles: this.countWithin(nodeId, first, first + windowS) };
    }
}
