/**
 * controllers/selfTuning.js - layer 3 of coordinated adaptive: the arterial's common cycle and every
 * node's split re-tuned from what the stop lines actually measure, SCATS-style.
 *
 * Every vehicle that enters a junction is counted against the stage it went on and the lane it came
 * from. Every `retuneEveryCycles` common cycles each stage's flow is the busiest lane's count over
 * that window - the same busiest-lane q the planned demand gives Webster - scaled up by
 * `saturatedBoost` when the stage kept running out of green while still busy (served flow under-reads
 * demand there). It is smoothed into the running estimate (EWMA) and fed to planCoordination() in
 * place of the planned demand: Webster itself and the saturation flow are untouched, only q changes.
 * The common cycle then moves at most `retuneMaxStepS` towards the critical junction's new cycle.
 *
 * The new plans carry `anchorS` = the common-cycle boundary they take effect from, so a node's cycle
 * position runs on without a jump when only the splits change; each controller takes its new plan up
 * as its arterial green next opens. Rebuilt with the controllers, so a power cut (or a mode change)
 * restarts it from the planned demand.
 *
 * It also re-decides selective coordination (chooseMarried()) from the same estimates every update, and the
 * common cycle then follows the critical MARRIED junction - a divorced one runs adaptive and has no cycle.
 */
import { COORDINATED_DEFAULTS } from '../equations.js';
import { FALLBACK_CYCLE_S, lostTimeS, minGreenOf } from './phasePlan.js';
import { planCoordination } from './greenWave.js';

/**
 * SCATS-style marriage: each link between neighbouring signals marries while the mean busiest-lane arterial flow at
 * its two ends is at least `marryFlowPerLaneMin` (and, once married, divorces only below `divorceRatio` of it), and
 * only if a platoon crosses it within `marryMaxTravelS`. A junction coordinates when any of its links is married.
 * Everything married when `coord.selective` is off.
 *
 * @param nodeInfos      the arterial's signalised node infos, in arterial order
 * @param arterialQ      (nodeId) => busiest-lane arterial flow there (veh/min per lane)
 * @param previousLinks  the married links (index of the link's first node) from the last decision, for the hysteresis
 * @returns { nodes: Set<nodeId>, links: Set<index> }
 */
export function chooseMarried(nodeInfos, arterialQ, targetSpeedMps, coord, previousLinks = new Set()) {
    const nodes = new Set();
    const links = new Set();
    // Not selective: the whole arterial coordinates, a lone signal included.
    if (!coord.selective) for (const info of nodeInfos) nodes.add(info.node.id);
    for (let i = 0; i < nodeInfos.length - 1; i += 1) {
        const [a, b] = [nodeInfos[i].node, nodeInfos[i + 1].node];
        const travelS = (b.sAlongM - a.sAlongM) / targetSpeedMps;
        const flow = (arterialQ(a.id) + arterialQ(b.id)) / 2;
        const threshold = coord.marryFlowPerLaneMin * (previousLinks.has(i) ? coord.divorceRatio : 1);
        if (coord.selective && (travelS > coord.marryMaxTravelS || flow < threshold)) continue;
        links.add(i);
        nodes.add(a.id);
        nodes.add(b.id);
    }
    return { nodes, links };
}

/** The common cycle the married junctions need: the longest own cycle among them - null when none is married. */
export function marriedCriticalCycle(plan, married) {
    const cycles = [...plan.nodes].filter(([nodeId]) => married.has(nodeId)).map(([, nodePlan]) => nodePlan.ownCycleS);
    return cycles.length ? Math.max(...cycles) : null;
}

/** Stage key: the road and whether it is that road's turn stage - '0', '0t', '1', '1t'. */
export function stageKey(phase, turn) {
    return `${phase}${turn ? 't' : ''}`;
}

export class SelfTuner {
    /**
     * nodeInfos/arterialDemandFor/crossDemandFor/turnFor/targetSpeedMps: what the planned-demand plan was built from (planCoordination()).
     * plan: that plan; nowS: when it took effect.
     * A connector route (coordinationRoutes.js) brings its own `planner` (planRoute()) and `marry` (chooseMarriedOnChains()),
     * and its `coordinatedPhase` (1) - whose measured flow decides the marriages.
     */
    constructor({ nodeInfos, arterialDemandFor, crossDemandFor, turnFor, targetSpeedMps, plan, nowS, coord = COORDINATED_DEFAULTS, planner = null, marry = null, coordinatedPhase = 0 }) {
        this.nodeInfos = nodeInfos;
        this.planner = planner ?? ((...args) => planCoordination(...args.slice(0, 4), targetSpeedMps, args[4]));
        this.marry = marry ?? ((q, previousLinks) => chooseMarried(nodeInfos, q, targetSpeedMps, coord, previousLinks));
        this.coordinatedPhase = coordinatedPhase;
        this.turnFor = turnFor;
        this.targetSpeedMps = targetSpeedMps;
        this.coord = coord;
        this.commonCycleS = plan.commonCycleS;
        this.anchorS = 0;
        this.maxCycleS = Math.max(FALLBACK_CYCLE_S, plan.commonCycleS);
        // No common cycle shorter than the one every junction's minimum greens fit into.
        this.minCycleS = Math.max(...[...plan.nodes.values()].map((p) => p.stages.reduce((sum, s) => sum + minGreenOf(s), 0) + lostTimeS(p.stages)));

        /** Per node: the planned demand objects (saturation flow kept) and the running q estimate per stage key. */
        this.estimates = new Map();
        for (const info of nodeInfos) {
            const node = info.node;
            const turn = turnFor(node);
            const planned = { 0: arterialDemandFor(node), 1: crossDemandFor(node), '0t': turn[0]?.demand ?? null, '1t': turn[1]?.demand ?? null };
            const q = {};
            for (const [key, demand] of Object.entries(planned)) q[key] = demand?.spawnRatePerLanePerMin ?? 0;
            this.estimates.set(node.id, { planned, q });
        }
        this.marriage = this.marry((nodeId) => this.estimates.get(nodeId).q[coordinatedPhase], undefined);
        this.windowStartS = nowS;
        this.cyclesInWindow = 0;
        this.nextBoundaryS = this._boundaryAfter(nowS);
        this._resetWindow();
        this.lastUpdate = null;
        this.updates = 0;
    }

    /** A vehicle entered `nodeId`'s junction from lane `laneKey`, on the stage `key`. */
    recordEntry(nodeId, key, laneKey) {
        const lanes = this.counts.get(nodeId)?.[key];
        if (lanes) lanes.set(laneKey, (lanes.get(laneKey) ?? 0) + 1);
    }

    /** A green at `nodeId` ended - `end` is the controller's lastEnd. */
    recordGreenEnd(nodeId, key, end) {
        const ends = this.ends.get(nodeId)?.[key];
        if (!ends) return;
        ends.total += 1;
        // Forced off (or, the arterial, yielded) with vehicles still crossing: it used all the green it had.
        if (end.busy && end.reason !== 'gapOut') ends.saturated += 1;
    }

    /**
     * Called every tick. On a re-tuning boundary returns the new plan (planCoordination()'s shape, each node
     * plan carrying anchorS), else null.
     */
    tick(nowS) {
        if (nowS < this.nextBoundaryS) return null;
        const boundaryS = this.nextBoundaryS;
        this.cyclesInWindow += 1;
        this.nextBoundaryS += this.commonCycleS;
        if (this.cyclesInWindow < this.coord.retuneEveryCycles) return null;
        return this._retune(boundaryS);
    }

    _retune(boundaryS) {
        const minutes = (boundaryS - this.windowStartS) / 60;
        const alpha = this.coord.retuneSmoothing;
        for (const info of this.nodeInfos) {
            const estimate = this.estimates.get(info.node.id);
            const counts = this.counts.get(info.node.id);
            const ends = this.ends.get(info.node.id);
            for (const key of Object.keys(estimate.q)) {
                if (!estimate.planned[key]) continue;
                const busiest = Math.max(0, ...counts[key].values());
                const saturated = ends[key].total > 0 && ends[key].saturated * 2 >= ends[key].total;
                const measured = (busiest / minutes) * (saturated ? 1 + this.coord.saturatedBoost : 1);
                estimate.q[key] = alpha * measured + (1 - alpha) * estimate.q[key];
            }
        }

        const demandOf = (node, key) => {
            const { planned, q } = this.estimates.get(node.id);
            return planned[key] && { ...planned[key], spawnRatePerLanePerMin: q[key] };
        };
        const turnFor = (node) =>
            this.turnFor(node).map((stage, phase) => stage && { ...stage, demand: demandOf(node, `${phase}t`) });
        const args = [this.nodeInfos, (node) => demandOf(node, 0), (node) => demandOf(node, 1), turnFor];

        this.marriage = this.marry((nodeId) => this.estimates.get(nodeId).q[this.coordinatedPhase], this.marriage.links);
        const target = marriedCriticalCycle(this.planner(...args, {}), this.marriage.nodes) ?? this.commonCycleS;
        const step = this.coord.retuneMaxStepS;
        const previousS = this.commonCycleS;
        this.commonCycleS = Math.min(this.maxCycleS, Math.max(this.minCycleS, previousS - step, Math.min(previousS + step, target)));
        const plan = this.planner(...args, { commonCycleS: this.commonCycleS });
        for (const nodePlan of plan.nodes.values()) nodePlan.anchorS = boundaryS;

        this.anchorS = boundaryS;
        this.nextBoundaryS = boundaryS + this.commonCycleS;
        this.windowStartS = boundaryS;
        this.cyclesInWindow = 0;
        this._resetWindow();
        this.updates += 1;
        this.lastUpdate = { atS: boundaryS, targetCycleS: target, commonCycleS: this.commonCycleS, married: this.marriage.nodes.size };
        return plan;
    }

    /** The first common-cycle boundary after `nowS` - node 0's cycle start, offsets measured from it. */
    _boundaryAfter(nowS) {
        return this.anchorS + Math.floor((nowS - this.anchorS) / this.commonCycleS + 1) * this.commonCycleS;
    }

    _resetWindow() {
        this.counts = new Map();
        this.ends = new Map();
        for (const info of this.nodeInfos) {
            this.counts.set(info.node.id, { 0: new Map(), 1: new Map(), '0t': new Map(), '1t': new Map() });
            this.ends.set(info.node.id, { 0: { total: 0, saturated: 0 }, 1: { total: 0, saturated: 0 }, '0t': { total: 0, saturated: 0 }, '1t': { total: 0, saturated: 0 } });
        }
    }
}
