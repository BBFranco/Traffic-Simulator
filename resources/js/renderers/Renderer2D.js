/**
 * Renderer2D.js - the existing canvas map (sim/renderer.js's LayoutRenderer)
 * behind the SimRenderer contract. Behaviour is deliberately unchanged: the
 * same setDynamicState() + draw() pair simulator.js always ran, no
 * interpolation, so the 2D view paints exactly what it did before.
 */
import { LayoutRenderer } from '../sim/renderer.js';

/** @implements {import('./RendererInterface.js').SimRenderer} */
export class Renderer2D {
    constructor(canvas) {
        /** The wrapped LayoutRenderer - simulator.js's pan/zoom/hover/layer handlers drive its camera directly. */
        this.inner = new LayoutRenderer(canvas);
    }

    init(layout) {
        this.inner.setLayout(layout);
    }

    update(snapshot) {
        this.inner.setDynamicState({ cars: snapshot.cars, signals: snapshot.signals, randomEvents: snapshot.randomEvents });
        this.inner.draw();
    }

    resize() {
        this.inner.resize();
    }

    setTheme(theme) {
        this.inner.setTheme(theme);
    }

    fit() {
        this.inner.fit();
    }

    /** Nothing GPU-backed to release - a 2D context is freed with its canvas, which stays on the page. */
    dispose() {}
}
