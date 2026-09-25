/**
 * SnapshotBuffer.js - smooth motion between 0.1 s ticks without touching the loop.
 *
 * simulator.js already takes one `engine.snapshot()` per animation frame. This
 * keeps the last two of those that sit at different sim times (A older, B newer)
 * and blends each car between them by its `id`. No extra per-tick work is added
 * to the engine loop, and nothing here is ever written back to the engine.
 *
 * Render time is `B.t - dt + alpha * dt`: at 1x (one tick every few frames) that
 * walks A -> B as the accumulator fills; at high speeds several ticks land per
 * frame and the blend simply sits near B.
 */

/** A jump bigger than this between two snapshots is a diversion/reset, not motion - snap instead of sliding across the map. */
const MAX_BLEND_JUMP_M = 30;

export class SnapshotBuffer {
    constructor() {
        this.clear();
    }

    clear() {
        this.older = null;
        this.newer = null;
        this.olderById = new Map();
        this.output = [];
    }

    push(snapshot) {
        if (this.newer && snapshot.simTimeS === this.newer.simTimeS) {
            // Same tick drawn again (paused, or a frame with no tick) - keep the
            // freshest object but leave the blend pair alone.
            this.newer = snapshot;
            return;
        }
        if (this.newer && snapshot.simTimeS < this.newer.simTimeS) {
            // Reset/reseed/new corridor: time went backwards, so there is nothing valid to blend from.
            this.older = null;
            this.olderById.clear();
            this.newer = snapshot;
            return;
        }

        this.older = this.newer;
        this.newer = snapshot;
        this.olderById.clear();
        if (this.older) {
            for (const car of this.older.cars) this.olderById.set(car.id, car);
        }
    }

    /**
     * Cars for this frame, blended by `alpha`. Returns a reused array of reused
     * objects - read it straight away, don't hold on to it.
     *
     * @returns {{id: number, x: number, y: number, hx: number, hy: number, stopped: boolean, vehicleType: string, colourIndex: number, lengthM: number, widthM: number}[]}
     */
    interpolatedCars(alpha, dtS) {
        const out = this.output;
        const cars = this.newer?.cars ?? [];
        out.length = cars.length;

        let f = 1;
        if (this.older) {
            const span = this.newer.simTimeS - this.older.simTimeS;
            const renderT = this.newer.simTimeS - dtS + Math.min(Math.max(alpha, 0), 1) * dtS;
            f = span > 0 ? Math.min(Math.max((renderT - this.older.simTimeS) / span, 0), 1) : 1;
        }

        for (let i = 0; i < cars.length; i += 1) {
            const car = cars[i];
            const slot = out[i] ?? (out[i] = {});
            const prev = f < 1 ? this.olderById.get(car.id) : undefined;

            let x = car.point.x;
            let y = car.point.y;
            let hx = car.heading.x;
            let hy = car.heading.y;
            if (prev && Math.hypot(car.point.x - prev.point.x, car.point.y - prev.point.y) < MAX_BLEND_JUMP_M) {
                x = prev.point.x + (car.point.x - prev.point.x) * f;
                y = prev.point.y + (car.point.y - prev.point.y) * f;
                const bx = prev.heading.x + (car.heading.x - prev.heading.x) * f;
                const by = prev.heading.y + (car.heading.y - prev.heading.y) * f;
                const len = Math.hypot(bx, by);
                if (len > 1e-6) {
                    hx = bx / len;
                    hy = by / len;
                }
            }

            slot.id = car.id;
            slot.x = x;
            slot.y = y;
            slot.hx = hx;
            slot.hy = hy;
            slot.stopped = car.stopped;
            slot.vehicleType = car.vehicleType;
            slot.colourIndex = car.colourIndex;
            slot.lengthM = car.lengthM;
            slot.widthM = car.widthM;
        }

        return out;
    }
}
