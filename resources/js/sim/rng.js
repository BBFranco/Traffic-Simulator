/**
 * rng.js - seeded PRNG (mulberry32).
 *
 * Every stochastic decision in the simulation (spawn timing via
 * equations.js:nextPoissonArrival, cross-routing dice rolls, sprite choice)
 * must draw from an instance of this, never from Math.random() directly -
 * that is what makes {seed, config} reproducible for the headless batch
 * runner and the seed-determinism verification check.
 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class SeededRandom {
    constructor(seed) {
        this.reseed(seed);
    }

    reseed(seed) {
        this.seed = seed >>> 0;
        this._next = mulberry32(this.seed);
    }

    /** Uniform float in [0, 1). */
    next() {
        return this._next();
    }
}
