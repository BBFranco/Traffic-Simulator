/**
 * metrics/zoneFlow.js - how much traffic each load-shedding zone takes in, and how much of it stands, minute by
 * minute - the zone 2 spillover's evidence from the batch itself (dissertation 6.1), not from a side probe.
 *
 * Read-only: engine.js's _addWait() reports each vehicle the first time its wait is charged to a zone (ZONE_ACCOUNTING:
 * it queued at or drove through that zone's junctions) and every tick's wait charged to one. Binned from the
 * measured start: `entered` vehicles per bin, and `standing` - the zone's wait-seconds over the bin's seconds, the
 * mean number of vehicles standing in it.
 */
export const ZONE_FLOW_BIN_S = 300;

export class ZoneFlow {
    constructor(startS) {
        this.startS = startS;
        /** zone -> per-bin counts / wait-seconds */
        this.entered = new Map();
        this.waitS = new Map();
    }

    _bin(nowS) {
        return Math.floor((nowS - this.startS) / ZONE_FLOW_BIN_S);
    }

    enter(zone, nowS) {
        bump(this.entered, zone, this._bin(nowS), 1);
    }

    wait(zone, seconds, nowS) {
        bump(this.waitS, zone, this._bin(nowS), seconds);
    }

    /** What a batch run stores (diagnostics.zoneFlow). */
    report() {
        const zones = [...new Set([...this.entered.keys(), ...this.waitS.keys()])].sort((a, b) => a - b);
        const bins = (series) => Array.from(series ?? [], (v) => v ?? 0);
        return {
            binS: ZONE_FLOW_BIN_S,
            entered: Object.fromEntries(zones.map((z) => [z, bins(this.entered.get(z))])),
            standing: Object.fromEntries(zones.map((z) => [z, bins(this.waitS.get(z)).map((s) => Math.round((s / ZONE_FLOW_BIN_S) * 10) / 10)])),
        };
    }
}

function bump(map, zone, bin, by) {
    let series = map.get(zone);
    if (!series) map.set(zone, (series = []));
    series[bin] = (series[bin] ?? 0) + by;
}
