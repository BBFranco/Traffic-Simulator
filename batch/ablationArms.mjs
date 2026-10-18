/**
 * Load-shedding ablation arms for coordinated adaptive (runBatch.mjs --ablation=<arm>): each is a set of coordination
 * overrides (equations.js COORDINATED_DEFAULTS). `baseline` changes nothing - the reference batch (coordinated adaptive
 * as it is, and plain adaptive) run the same way, so every arm pairs with it seed for seed.
 *
 *   A1 - zone 3's resync hold runs through the whole outage: restored at minute 30, married again only at minute 45
 *   A2 - zone 3's arterial routes run a free cycle while zone 2 is dark (re-planned every cycle on measured flow, no step cap)
 *   A3 - the Jan Shoba route never marries a junction
 *   A4 - zone 3's arterial routes run without platoon messages while zone 2 is dark (no holds, no early cross-green ends)
 *   legacyRestart - a junction rebuilt on the resync hold starts part-way into the background plan, as before 2026-10-18
 *                   (restartOnArterialGreen off) - reproduces 1e58298-era coordinated outage results
 *
 * The A5 arm (held junctions start on the arterial green) became the default (restartOnArterialGreen) on 2026-10-18, so
 * A1-A4 now run on top of it; their 2026-10-18 batches ran on the legacy restart.
 */
export const ABLATION_ARMS = {
    baseline: { label: 'baseline (no ablation)', coordination: {} },
    A1: { label: 'A1 zone 3 resync hold through the outage', coordination: { recoveryHoldThroughOutageZones: [3] } },
    A2: { label: 'A2 zone 3 free cycle while zone 2 is dark', coordination: { freeCycleZones: [3] } },
    A3: { label: 'A3 Jan Shoba route marriage off', coordination: { connectorRouteMarriage: false } },
    A4: { label: 'A4 zone 3 platoon messages off while zone 2 is dark', coordination: { noPlatoonMessageZones: [3] } },
    legacyRestart: { label: 'legacy restart (mid-plan) after power returns', coordination: { restartOnArterialGreen: false } },
};
