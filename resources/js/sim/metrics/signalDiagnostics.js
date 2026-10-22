/**
 * metrics/signalDiagnostics.js - what the actuated signals did, for the sensor question's mechanism (dissertation plan
 * step 17): how long a call waits for its green, and how long the greens run.
 *
 * Read-only: engine.js hands it each adaptive / coordinated adaptive junction's controller and detector frames every
 * tick, after the controller has stepped; it never moves a car or draws from a random stream.
 *
 * Call-to-service: from the first tick a red road's detectors show a call (`presence` on any of its approach frames)
 * to that road's next green - its turn arrow or its through green, whichever opens first. It includes the detection
 * itself: a sensor whose zone sees the queue later starts the clock later, which is the point.
 * Greens: each through green and each turn arrow, from opening to its amber, by road; a through green ending at the
 * controller's maxGreen counts as a max-out.
 *
 * Per stage of the batch schedule (runHeadless.js's setStage(): 'pre', 'during', 'stage1', 'stage2', 'post'), or
 * 'all' at normal power. A junction's controller is rebuilt when its power returns, so the state is kept per
 * controller - a call pending as the lights went out is dropped, not charged with the dark spell.
 */

export class SignalDiagnostics {
    constructor() {
        this.stage = null;
        /** stage -> { callToServiceS, arterialGreenS, crossGreenS, turnGreenS: { n, sumS }, maxOuts } */
        this.byStage = new Map();
        /** controller -> { greenKey, greenSinceS, callSinceS: [arterial, cross] } */
        this.state = new WeakMap();
    }

    setStage(stage) {
        this.stage = stage;
    }

    _row() {
        const key = this.stage ?? 'all';
        let row = this.byStage.get(key);
        if (!row) {
            const tally = () => ({ n: 0, sumS: 0 });
            row = { callToServiceS: tally(), arterialGreenS: tally(), crossGreenS: tally(), turnGreenS: tally(), maxOuts: 0 };
            this.byStage.set(key, row);
        }
        return row;
    }

    /** One junction after its controller's step: `phaseFrames` [arterial, cross] are its approach detector frames. */
    observe(controller, phaseFrames, nowS) {
        let s = this.state.get(controller);
        if (!s) this.state.set(controller, (s = { greenKey: null, greenSinceS: null, greenElapsedS: 0, callSinceS: [null, null] }));
        const greenKey = controller.phaseState === 'green' ? `${controller.phase}${controller.inTurn ? 't' : ''}` : null;

        if (greenKey !== s.greenKey) {
            if (s.greenKey != null && s.greenSinceS != null) this._greenEnded(controller, s);
            if (greenKey != null) {
                const callSinceS = s.callSinceS[controller.phase];
                if (callSinceS != null) add(this._row().callToServiceS, nowS - callSinceS);
                s.callSinceS[controller.phase] = null;
            }
            s.greenKey = greenKey;
            s.greenSinceS = greenKey == null ? null : nowS;
        }
        if (greenKey != null) s.greenElapsedS = nowS - s.greenSinceS;

        // A road with no green showing whose detectors see a vehicle has a call on - from its first tick.
        for (const phase of [0, 1]) {
            const served = greenKey != null && controller.phase === phase;
            if (served || s.callSinceS[phase] != null) continue;
            if (phaseFrames[phase]?.some((frame) => frame.presence)) s.callSinceS[phase] = nowS;
        }
    }

    _greenEnded(controller, s) {
        const row = this._row();
        const turn = s.greenKey.endsWith('t');
        add(turn ? row.turnGreenS : s.greenKey === '0' ? row.arterialGreenS : row.crossGreenS, s.greenElapsedS);
        const maxGreen = controller.params?.maxGreen;
        if (!turn && maxGreen != null && s.greenElapsedS >= maxGreen - 0.05) row.maxOuts += 1;
    }

    /** What a batch run stores (diagnostics.signals): per stage, each tally's count and mean in seconds. */
    report() {
        const mean = ({ n, sumS }) => ({ n, meanS: n ? Math.round((sumS / n) * 10) / 10 : null });
        return Object.fromEntries(
            [...this.byStage].map(([stage, row]) => [
                stage,
                {
                    callToService: mean(row.callToServiceS),
                    arterialGreen: mean(row.arterialGreenS),
                    crossGreen: mean(row.crossGreenS),
                    turnGreen: mean(row.turnGreenS),
                    maxOutShare: row.arterialGreenS.n + row.crossGreenS.n ? Math.round((row.maxOuts / (row.arterialGreenS.n + row.crossGreenS.n)) * 1000) / 1000 : null,
                },
            ])
        );
    }
}

function add(tally, seconds) {
    tally.n += 1;
    tally.sumS += seconds;
}
