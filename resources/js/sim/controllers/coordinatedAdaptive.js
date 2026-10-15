/**
 * controllers/coordinatedAdaptive.js - adaptive actuation inside a coordinated background cycle.
 *
 * The background is green wave's plan (greenWave.js's planCoordination()): one common cycle on the
 * arterial, a per-node offset so a platoon released at one junction meets the next green, and
 * Webster splits. On top of it the junction actuates like adaptive.js, the way an actuated-
 * coordinated (NEMA-style) controller does:
 *
 *  - The arterial through green is the coordinated phase. It never ends before its planned end
 *    (the yield point), which protects the progression band. From the yield point on it yields to a
 *    sufficient call on the cross street - or rests in green while there is none.
 *  - The cross street and the turn stages are actuated: minimum green, then they gap out - but each
 *    is forced off at its planned end, so the arterial green opens on time for the next platoon.
 *  - Early return: whatever a gapped-out (or uncalled) stage leaves unused goes to the arterial.
 *  - A late yield is only taken while the cross street can still get its minimum green before its
 *    force-off (the permissive window); past that the arterial rests on to the next yield point.
 *  - Re-service: an arterial green that got its time back early (the cross street gapped out) gives
 *    it up again - once it has gapped out itself - to a cross street that calls again while its own
 *    planned window is still open. The arterial's planned green lies after that window, so the
 *    progression band is untouched; the cross street just isn't made to wait a whole cycle.
 *
 * Layer 2 (platoon messages, coordinationBus.js) bends that a little: an arterial green that is
 * about to yield holds for a platoon the upstream junction says is just arriving, and a cross green
 * that has thinned out ends early to open the arterial for one. Both are bounded by the same force-
 * offs, so the cross street is never pushed past its planned window.
 *
 * Side-street wait cap (`coord.sideWaitCap`): once the cross street's call has waited `sideMaxWaitS`, the arterial
 * gives way as soon as its own minimum is met - no yield point, no permissive window - and the cross street's
 * green that follows isn't forced off: it runs on adaptive's rules (gap-out, maxGreen) until its queue clears. The
 * yield points pick the coordination back up from the next arterial green.
 *
 * Selective coordination (selfTuning.js's chooseMarried()): a junction on no strong link is "divorced" and runs
 * plain adaptive rules - minimum green, gap-out, maximum green, rest on no call - with no cycle at all. It
 * marries back in as its arterial green next opens.
 *
 * Time is absolute sim time: the node's cycle position is `(t - anchorS - offsetS) mod C`, `anchorS`
 * being where self-tuning (selfTuning.js) last changed the common cycle - 0 until then, which makes
 * the background timing identical to green wave's. A new plan (setPlan()) is taken up as the
 * arterial green next opens, never mid-stage.
 */
import { ADAPTIVE_DEFAULTS, COORDINATED_DEFAULTS, shouldExtendGreen } from '../equations.js';
import { MAX_TURN_GREEN_S } from './adaptive.js';
import { ALL_RED_S, MIN_TURN_GREEN_S, YELLOW_S } from './phasePlan.js';

const CLEARANCE_S = YELLOW_S + ALL_RED_S;
/** A handover this close to the window's end still goes - a split that exactly fits isn't lost to the tick it falls between. */
const WINDOW_TOLERANCE_S = 0.5;

function mod(a, n) {
    return ((a % n) + n) % n;
}

/**
 * The plan in "u-space", time since the node's yield point (the planned end of its arterial
 * through green): each stage's planned green start and end, and where the yield point falls in
 * absolute time. The arterial's own green is [C - gA, C); every other stage lies inside [0, C - gA).
 */
export function layoutPlan({ offsetS, cycleLengthS, stages, stageGreens, anchorS = 0 }) {
    const C = cycleLengthS;
    const starts = [];
    let acc = 0;
    stages.forEach((_, i) => {
        starts.push(acc);
        acc += stageGreens[i] + CLEARANCE_S;
    });
    const arterialIndex = stages.findIndex((s) => s.phase === 0 && !s.turn);
    const yieldTc = starts[arterialIndex] + stageGreens[arterialIndex];
    const uStart = starts.map((s) => mod(s - yieldTc, C));
    const uEnd = stages.map((_, i) => (i === arterialIndex ? C : uStart[i] + stageGreens[i]));
    return {
        C,
        stages,
        stageGreens,
        arterialIndex,
        uStart,
        uEnd,
        /** Absolute time of one yield point - every other is a whole number of cycles from it. */
        yieldOriginS: anchorS + offsetS + yieldTc,
        offsetS,
        anchorS,
    };
}

export class CoordinatedAdaptiveController {
    /**
     * plan: { offsetS, cycleLengthS, stages, stageGreens, anchorS? } - one node's entry of planCoordination().
     * simTimeS: now - the controller starts wherever the plan says it should be at this moment.
     */
    constructor(plan, simTimeS, { params = ADAPTIVE_DEFAULTS, coord = COORDINATED_DEFAULTS, married = true } = {}) {
        this.params = params;
        this.coord = coord;
        /** Coordinated (on a married link) or running plain adaptive - see setMarried(). */
        this.married = married;
        this.pendingMarried = false;
        this.pendingPlan = null;
        this._applyPlan(plan);
        /** When the arterial green last ended - a yield point after it that the arterial wasn't green for was missed. */
        this.lastArterialEndS = -Infinity;
        /** The yield point the current non-arterial stages are timed from - their force-offs are this plus their planned end. */
        this.cycleBaseS = 0;
        this.yieldAtS = Infinity;
        this.forceOffAtS = Infinity;
        this.platoonHeldS = 0; // how long a platoon has held this arterial green past its yield point
        /** How long the cross street's call has been waiting (engine.js's callPersistenceS), and whether the stages now running were brought on by the cap. */
        this.crossWaitS = 0;
        this.capServing = false;
        this.secondsSinceLastDetection = 0;
        /** Why the last green ended, how long it ran and whether it was still busy - the tooltip reads it. */
        this.lastEnd = null;
        /** Self-tuning's hook, called with `lastEnd` as each green ends. */
        this.onGreenEnd = null;
        this._placeAt(simTimeS);
    }

    /** Per road, null or its turn stage's weight - same shape as AdaptiveController's. */
    get turnWeights() {
        return [0, 1].map((p) => this.layout.stages.find((s) => s.phase === p && s.turn)?.weight ?? null);
    }

    get cycleLengthS() {
        return this.layout.C;
    }

    isArterialGreen() {
        return this.phase === 0 && !this.inTurn && this.phaseState === 'green';
    }

    isCrossGreen() {
        return this.phase === 1 && !this.inTurn && this.phaseState === 'green';
    }

    /** Is road `phase`'s protected turn showing its green arrow. */
    turnGreen(phase) {
        return this.inTurn && this.phase === phase && this.phaseState === 'green';
    }

    turnYellow(phase) {
        return this.inTurn && this.phase === phase && this.phaseState === 'yellow';
    }

    /**
     * Selective coordination's verdict. Divorcing takes effect at once - adaptive rules need no cycle position;
     * marrying waits for the arterial green to open, where the coordinated timing picks up from its yield points.
     */
    setMarried(married) {
        if (!married) this.married = false;
        this.pendingMarried = married && !this.married;
    }

    /** Self-tuning's new plan - taken up as the arterial green next opens. */
    setPlan(plan) {
        this.pendingPlan = plan;
    }

    /** Where in its own cycle the node is (0 = the start of its first stage), for the tooltip. */
    cyclePositionS(simTimeS) {
        return mod(simTimeS - this.layout.anchorS - this.layout.offsetS, this.layout.C);
    }

    /** The latest yield point at or before `simTimeS`. */
    prevYieldAt(simTimeS) {
        return simTimeS - mod(simTimeS - this.layout.yieldOriginS, this.layout.C);
    }

    /**
     * vehicleDetectedThisTick, otherCallSufficient, turnCalls: exactly AdaptiveController.tick()'s.
     * platoon: null (layer 2 off), or `(fromS, toS) => vehicles` the upstream junctions say arrive in that window.
     * crossWaitS: how long the cross street's call has been waiting - the side-street cap's clock.
     */
    tick(dt, simTimeS, vehicleDetectedThisTick, otherCallSufficient = false, turnCalls = [false, false], platoon = null, crossWaitS = 0) {
        this.phaseElapsed += dt;
        this.crossWaitS = crossWaitS;
        const now = simTimeS;

        if (this.phaseState === 'green') {
            this.secondsSinceLastDetection = vehicleDetectedThisTick ? 0 : this.secondsSinceLastDetection + dt;
            const end = !this.married
                ? this._isolatedEnds(otherCallSufficient)
                : this.stageIndex === this.layout.arterialIndex
                  ? this._arterialEnds(now, dt, otherCallSufficient, turnCalls, platoon)
                  : this._actuatedEnds(now, turnCalls, platoon);
            if (end) {
                // Still busy: vehicles were crossing right up to the end - the stage used all the green it got.
                const busy = this.secondsSinceLastDetection < this.coord.busyGapS;
                this.lastEnd = { stageIndex: this.stageIndex, reason: end, atS: now, greenS: this.phaseElapsed, busy };
                this.onGreenEnd?.(this.lastEnd);
                if (this.stageIndex === this.layout.arterialIndex) this.lastArterialEndS = now;
                this.phaseState = 'yellow';
                this.phaseElapsed = 0;
            }
        } else if (this.phaseState === 'yellow' && this.phaseElapsed >= YELLOW_S) {
            this.phaseState = 'allRed';
            this.phaseElapsed = 0;
        } else if (this.phaseState === 'allRed' && this.phaseElapsed >= ALL_RED_S) {
            this._startStage(this.married ? this._nextStage(now, turnCalls) : this._isolatedNext(turnCalls), now);
        }
    }

    /** Divorced: adaptive.js's rules exactly - a turn stage gaps out or caps at its weighted maximum; a through green extends on detections while the other road has a sufficient call, rests otherwise, and caps at maxGreen. */
    _isolatedEnds(otherCallSufficient) {
        const stage = this.layout.stages[this.stageIndex];
        if (stage.turn) {
            if (this.phaseElapsed >= MAX_TURN_GREEN_S * stage.weight) return 'maxOut';
            return this.phaseElapsed >= MIN_TURN_GREEN_S * stage.weight && this.secondsSinceLastDetection >= this.params.gapOutS ? 'gapOut' : null;
        }
        if (this.phaseElapsed >= this.params.maxGreen) return 'maxOut';
        return shouldExtendGreen(this.secondsSinceLastDetection, this.phaseElapsed, this.params) || !otherCallSufficient ? null : 'gapOut';
    }

    /** Divorced: a turn stage hands over to its own road's through green; a through green to the other road - its turn stage first when called. */
    _isolatedNext(turnCalls) {
        const { stages } = this.layout;
        const stage = stages[this.stageIndex];
        const through = (phase) => stages.findIndex((s) => s.phase === phase && !s.turn);
        if (stage.turn) return through(stage.phase);
        const other = 1 - stage.phase;
        const turn = stages.findIndex((s) => s.phase === other && s.turn);
        return turn >= 0 && turnCalls[other] ? turn : through(other);
    }

    /** Does the coordinated arterial green end this tick - returns why, or null to hold. */
    _arterialEnds(now, dt, otherCallSufficient, turnCalls, platoon) {
        if (this.phaseElapsed < this._minGreenOf(this.stageIndex)) return null;
        if (this._sideCapped()) return 'sideCap';
        if (now < this.yieldAtS) return this._mayReserve(now, otherCallSufficient, turnCalls) ? 'reservice' : null;
        const slackS = this._windowSlackS(this._stageAfterArterial(turnCalls), now);
        if (slackS < -WINDOW_TOLERANCE_S) {
            // Too late in the cycle to serve the cross street before its force-off: rest to the next yield point.
            this.yieldAtS = this.prevYieldAt(now) + this.layout.C;
            this.platoonHeldS = 0;
            return null;
        }
        if (!otherCallSufficient) return null;
        // A platoon may hold it, but never through the window's last tick - the waiting call isn't put off a whole cycle for it.
        const platoonDue = platoon && slackS > dt && this.platoonHeldS < this.coord.platoonExtendMaxS;
        if (platoonDue && platoon(now, now + this.coord.platoonLookaheadS) >= this.coord.platoonMinCars) {
            this.platoonHeldS += dt;
            return null;
        }
        return 'yield';
    }

    /**
     * Re-service: has this arterial green (an early return, before its yield point) gapped out with the cross street
     * calling again, while that street's planned window - this cycle's, timed from the yield point it was served
     * after - still has room for its minimum green.
     */
    _mayReserve(now, otherCallSufficient, turnCalls) {
        if (!this.coord.reservice || !otherCallSufficient || this.secondsSinceLastDetection < this.params.gapOutS) return false;
        if (this.lastArterialEndS < this.cycleBaseS - WINDOW_TOLERANCE_S) return false; // not an early return - it hasn't yielded this cycle
        return this._windowSlackS(this._stageAfterArterial(turnCalls), now, this.cycleBaseS) >= -WINDOW_TOLERANCE_S;
    }

    /** Has the cross street's call waited past the side-street cap. */
    _sideCapped() {
        return this.coord.sideWaitCap && this.crossWaitS >= this.coord.sideMaxWaitS;
    }

    /** Does an actuated (cross or turn) green end this tick - returns why, or null to hold. */
    _actuatedEnds(now, turnCalls, platoon) {
        if (this.phaseElapsed < this._minGreenOf(this.stageIndex)) return null;
        // Brought on by the side-street cap: no force-off - it runs on adaptive's rules until its queue clears.
        if (this.capServing) {
            if (this.phaseElapsed >= this.params.maxGreen) return 'maxOut';
            return this.secondsSinceLastDetection >= this.params.gapOutS ? 'gapOut' : null;
        }
        if (now >= this.forceOffAtS) return 'forceOff';
        if (this.secondsSinceLastDetection >= this.params.gapOutS) return 'gapOut';
        if (platoon && this.secondsSinceLastDetection >= this.coord.earlyStartGapS && this._nextIsArterial(turnCalls)) {
            const dueBy = now + CLEARANCE_S + this.coord.earlyStartLeadS;
            if (platoon(now, dueBy) >= this.coord.platoonMinCars) return 'platoonEarly';
        }
        return null;
    }

    /** Would the arterial through green follow the current stage. */
    _nextIsArterial(turnCalls) {
        const { stages, arterialIndex } = this.layout;
        const nextIndex = (this.stageIndex + 1) % stages.length;
        return nextIndex === arterialIndex || (stages[nextIndex].turn && stages[nextIndex].phase === 0 && !turnCalls[0]);
    }

    /** The stage the arterial hands over to: the cross street's turn stage when it has a call, else its through green. */
    _stageAfterArterial(turnCalls) {
        const { stages, arterialIndex } = this.layout;
        const next = (arterialIndex + 1) % stages.length;
        return stages[next].turn && !turnCalls[stages[next].phase] ? (next + 1) % stages.length : next;
    }

    /**
     * How long the arterial can still wait before handing over to `stageIndex` and leaving the cross street its minimum
     * green before its force-off - negative once that's too late (the permissive window has closed).
     */
    _windowSlackS(stageIndex, now, base = this.prevYieldAt(now)) {
        const { stages, uEnd } = this.layout;
        let needS = 0;
        // A cross turn stage in front adds its own minimum; the cross through's force-off is the one that binds.
        let i = stageIndex;
        while (stages[i].turn) {
            needS += CLEARANCE_S + this._minGreenOf(i);
            i = (i + 1) % stages.length;
        }
        needS += CLEARANCE_S + this._minGreenOf(i);
        return base + uEnd[i] - now - needS;
    }

    /**
     * A stage's minimum green: adaptive's (a turn's weighted one), but never more than the plan gives it - the plan's
     * splits floor at fixed-time's shorter minimum, and a minimum longer than the split would never fit its window.
     */
    _minGreenOf(stageIndex) {
        const stage = this.layout.stages[stageIndex];
        const minS = stage.turn ? MIN_TURN_GREEN_S * stage.weight : this.params.minGreen;
        return Math.min(minS, this.layout.stageGreens[stageIndex]);
    }

    _nextStage(now, turnCalls) {
        const { stages, arterialIndex } = this.layout;
        if (this.stageIndex === arterialIndex) return this._stageAfterArterial(turnCalls);
        let next = (this.stageIndex + 1) % stages.length;
        // Skip an uncalled turn stage, and one too late to fit its minimum before its force-off.
        if (next !== arterialIndex && stages[next].turn) {
            const fits = this.cycleBaseS + this.layout.uEnd[next] - now >= this._minGreenOf(next) - WINDOW_TOLERANCE_S;
            if (!turnCalls[stages[next].phase] || !fits) next = (next + 1) % stages.length;
        }
        return next;
    }

    _startStage(stageIndex, now) {
        const { arterialIndex } = this.layout;
        if (stageIndex === arterialIndex) {
            if (this.pendingMarried) {
                this.married = true;
                this.pendingMarried = false;
            }
            if (this.pendingPlan) {
                this._applyPlan(this.pendingPlan);
                this.pendingPlan = null;
            }
            const prevYield = this.prevYieldAt(now);
            // A yield point passed while the arterial was red (a stage ran late) is still open to it; otherwise it holds to the next.
            this.yieldAtS = prevYield > this.lastArterialEndS ? prevYield : prevYield + this.layout.C;
            this.forceOffAtS = Infinity;
            this.platoonHeldS = 0;
            this.capServing = false;
        } else {
            if (this.stageIndex === arterialIndex) this.capServing = this.lastEnd?.reason === 'sideCap';
            if (this.stageIndex === arterialIndex) this.cycleBaseS = this.prevYieldAt(now);
            this.forceOffAtS = this.cycleBaseS + this.layout.uEnd[stageIndex];
        }
        this._enter(stageIndex, 'green', 0);
    }

    _enter(stageIndex, phaseState, phaseElapsed) {
        const stage = this.layout.stages[stageIndex];
        this.stageIndex = stageIndex;
        this.phase = stage.phase;
        this.inTurn = stage.turn;
        this.phaseState = phaseState;
        this.phaseElapsed = phaseElapsed;
        this.secondsSinceLastDetection = 0;
    }

    _applyPlan(plan) {
        this.plan = plan;
        this.layout = layoutPlan(plan);
    }

    /** Start in whichever stage the plan has at `simTimeS`, with that stage's force-off or yield point. */
    _placeAt(simTimeS) {
        const { C, stages, stageGreens, uStart, arterialIndex } = this.layout;
        this.cycleBaseS = this.prevYieldAt(simTimeS);
        const u = simTimeS - this.cycleBaseS;
        for (let i = 0; i < stages.length; i += 1) {
            const into = mod(u - uStart[i], C);
            if (into >= stageGreens[i] + CLEARANCE_S) continue;
            const state = into < stageGreens[i] ? 'green' : into < stageGreens[i] + YELLOW_S ? 'yellow' : 'allRed';
            const elapsed = state === 'green' ? into : state === 'yellow' ? into - stageGreens[i] : into - stageGreens[i] - YELLOW_S;
            this._enter(i, state, elapsed);
            if (i === arterialIndex) {
                // In the planned arterial green its yield point is the next one; in its amber it has just yielded.
                this.yieldAtS = state === 'green' ? this.cycleBaseS + C : this.cycleBaseS;
                if (state !== 'green') this.lastArterialEndS = simTimeS - elapsed;
            } else {
                this.forceOffAtS = this.cycleBaseS + this.layout.uEnd[i];
            }
            return;
        }
        this._enter(arterialIndex, 'green', 0); // floating-point edge at exactly a boundary
        this.yieldAtS = this.cycleBaseS + C;
    }
}
