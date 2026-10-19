/**
 * controllers/coordinationStats.js - what coordinated adaptive actually did over a run, for the report's
 * coordination section: how much of the time each junction was married, the common cycle self-tuning held
  * each route on, how often the resync hold ran, what the platoon messages did, and how every green ended.
 *
 * Recording only - it reads the controllers, never steers them, and draws no random numbers. Sampled only while
 * coordinated controllers exist (normal power); reset with the engine's other stats at the end of warm-up.
 */
export class CoordinationStats {
    constructor() {
        /** controller -> its platoonHeldS last tick, to count hold episodes and seconds (a WeakMap: controllers are rebuilt). */
        this.heldBefore = new WeakMap();
        this.reset();
    }

    reset() {
        this.byNode = new Map();
        this.byRoute = new Map();
        this.recoveryHolds = 0;
        this.recoveryHoldS = 0;
        this.platoon = { messages: 0, holds: 0, holdS: 0 };
        this.greenEnds = {};
        /** Seconds the network sat dark under load shedding - every junction that was coordinating was unmarried through them. */
        this.darkS = 0;
        /** Set by the first lit sample: the run coordinates, so dark time is worth counting. */
        this.tracking = false;
        /** The outage stage now (runHeadless.js's setStage(): 'pre', 'during', 'stage1', 'stage2', 'post'), or null outside a batch schedule. */
        this.stage = null;
        /** Per stage: Jan Shoba's signals' (routeNodeIds) junction-seconds and married seconds, and its route's common cycle. */
        this.byStage = new Map();
        /** Every power return that started a resync hold: { atS, stage, holdS }. */
        this.restores = [];
    }

    /** runHeadless.js: the batch schedule's stage from here on - every sample after it counts in that stage's row. */
    setStage(stage) {
        this.stage = stage;
    }

    _stageRow() {
        if (this.stage == null) return null;
        let row = this.byStage.get(this.stage);
        if (!row) this.byStage.set(this.stage, (row = { nodeS: 0, marriedS: 0, routeS: 0, cycleSum: 0 }));
        return row;
    }

    /** One tick of one coordination group (an arterial, or a connector route): its junctions' married time, its common cycle, and any platoon hold. */
    sample(dt, routeId, nodeInfos, commonCycleS) {
        this.tracking = true;
        const route = this._route(routeId);
        route.seconds += dt;
        route.cycleSum += commonCycleS * dt;
        route.minCycleS = Math.min(route.minCycleS, commonCycleS);
        route.maxCycleS = Math.max(route.maxCycleS, commonCycleS);
        route.finalCycleS = commonCycleS;
        const stageRow = this._stageRow();
        if (stageRow && routeId.startsWith('route:')) {
            stageRow.routeS += dt;
            stageRow.cycleSum += commonCycleS * dt;
        }

        for (const info of nodeInfos) {
            const { controller } = info;
            let node = this.byNode.get(info.node.id);
            if (!node) this.byNode.set(info.node.id, (node = { routeId, seconds: 0, marriedS: 0 }));
            node.seconds += dt;
            if (controller.married) node.marriedS += dt;
            if (stageRow && this.routeNodeIds?.has(info.node.id)) {
                stageRow.nodeS += dt;
                if (controller.married) stageRow.marriedS += dt;
            }

            const held = controller.platoonHeldS;
            const before = this.heldBefore.get(controller) ?? 0;
            if (held > before) {
                this.platoon.holdS += held - before;
                if (before === 0) this.platoon.holds += 1;
            }
            this.heldBefore.set(controller, held);
        }
    }

    sampleDark(dt) {
        this.darkS += dt;
        const stageRow = this._stageRow();
        if (stageRow) for (const nodeId of this.byNode.keys()) if (this.routeNodeIds?.has(nodeId)) stageRow.nodeS += dt;
    }

    /** A rolling blackout's tick: only \`darkNodes\` sat dark (unmarried) - each coordinating one's own dark time. */
    sampleDarkNodes(dt, darkNodes) {
        const stageRow = this._stageRow();
        for (const [nodeId, node] of this.byNode) {
            if (!darkNodes.has(nodeId)) continue;
            node.darkS = (node.darkS ?? 0) + dt;
            if (stageRow && this.routeNodeIds?.has(nodeId)) stageRow.nodeS += dt;
        }
    }

    onRetune(routeId) {
        this._route(routeId).retunes += 1;
    }

    onGreenEnd(reason) {
        this.greenEnds[reason] = (this.greenEnds[reason] ?? 0) + 1;
    }

    onPlatoonMessage() {
        this.platoon.messages += 1;
    }

    onRecoveryHold(seconds, atS = null) {
        this.recoveryHolds += 1;
        this.recoveryHoldS += seconds;
        this.restores.push({ atS, stage: this.stage, holdS: seconds });
    }

    /** The run's record - plain JSON, rounded. `measuredS` is coordinated junction-time, the base for every share. */
    summary() {
        const round = (value, places = 1) => (value == null ? null : Number(value.toFixed(places)));
        const nodes = [...this.byNode.values()];
        // A rolling blackout's dark time is per junction (darkS); a total blackout's is everyone's (this.darkS).
        const nodeDarkS = (node) => this.darkS + (node.darkS ?? 0);
        const seconds = nodes.reduce((sum, node) => sum + node.seconds + nodeDarkS(node), 0);
        const marriedS = nodes.reduce((sum, node) => sum + node.marriedS, 0);
        return {
            measuredS: round(seconds),
            marriedShare: seconds ? round(marriedS / seconds, 3) : null,
            darkS: round(this.darkS),
            nodes: Object.fromEntries(
                [...this.byNode].map(([nodeId, node]) => [nodeId, { routeId: node.routeId, marriedShare: node.seconds ? round(node.marriedS / (node.seconds + nodeDarkS(node)), 3) : null }])
            ),
            routes: Object.fromEntries(
                [...this.byRoute].map(([routeId, a]) => [
                    routeId,
                    { meanCycleS: a.seconds ? round(a.cycleSum / a.seconds) : null, minCycleS: round(a.minCycleS), maxCycleS: round(a.maxCycleS), finalCycleS: round(a.finalCycleS), retunes: a.retunes },
                ])
            ),
            recoveryHolds: this.recoveryHolds,
            recoveryHoldS: round(this.recoveryHoldS),
            platoon: { messages: this.platoon.messages, holds: this.platoon.holds, holdS: round(this.platoon.holdS) },
            greenEnds: { ...this.greenEnds },
            // Batch schedule runs only: Jan Shoba's married share and route cycle per stage. A stage with part of the route
            // dark has a cycle over its lit signals only - the report shows it for pre and post alone.
            ...(this.byStage.size
                ? {
                      byStage: Object.fromEntries(
                          [...this.byStage].map(([stage, row]) => [stage, { marriedShare: row.nodeS ? round(row.marriedS / row.nodeS, 3) : null, routeCycleS: row.routeS ? round(row.cycleSum / row.routeS) : null }])
                      ),
                      restores: this.restores.map((r) => ({ atS: round(r.atS), stage: r.stage, holdS: round(r.holdS) })),
                  }
                : {}),
        };
    }

    _route(routeId) {
        let route = this.byRoute.get(routeId);
        if (!route) this.byRoute.set(routeId, (route = { seconds: 0, cycleSum: 0, minCycleS: Infinity, maxCycleS: -Infinity, finalCycleS: null, retunes: 0 }));
        return route;
    }
}
