/**
 * renderer.js - canvas draw layer for the road network.
 *
 * PHASE 1 SCOPE: draws the static layout produced by `corridor.js` - road
 * surfaces, lane markings, stop lines, junction boxes, unlit signal heads and
 * labels - plus a pan/zoom camera. There is no tick loop here and nothing
 * animates; `draw()` runs on demand (resize, camera change, control change).
 *
 * In Phase 2, `engine.js` owns the tick loop and calls into this module each
 * frame, then draws cars and lit signal heads on top of the same output. The
 * split exists so the road never has to be re-drawn differently once the
 * simulation lands.
 */

/**
 * Per-arterial accent colours - the single identity palette, used for canvas
 * dots, the stats-footer columns and the footer chart's series so an arterial is
 * the same colour everywhere.
 *
 * Validated for a dark surface: all four sit inside OKLCH L 0.48-0.67, clear the
 * chroma floor, hold >= 3:1 against the surface, and the worst adjacent pair
 * separates by dE 23 under protanopia. Accents mark; they never carry text -
 * labels stay in a text token with a coloured dot beside them.
 */
export const ARTERIAL_ACCENTS = ['#0284c7', '#ea580c', '#8b5cf6', '#059669'];

/**
 * Two map palettes, one per theme. Not an inversion of each other: on the light
 * map the asphalt is a pale grey and the markings go DARK, because white lane
 * lines on a light carriageway would be invisible. Both are legible schematics
 * rather than photoreal roads.
 */
const PALETTES = {
    light: {
        void: '#f8fafc',
        groundGrid: 'rgba(15, 23, 42, 0.05)',
        // Kept a clear step darker than `void` so the carriageway reads as a road
        // rather than dissolving into the page.
        asphalt: '#d1d9e2',
        asphaltEdge: '#9aa6b6',
        junction: '#e6ebf1',
        junctionEdge: '#94a3b8',
        laneDash: 'rgba(51, 65, 85, 0.40)',
        edgeLine: 'rgba(51, 65, 85, 0.45)',
        centreLine: '#b45309',
        stopLine: 'rgba(30, 41, 59, 0.75)',
        arrow: 'rgba(51, 65, 85, 0.45)',
        // A real signal housing is dark in any light, so it stays dark in both
        // themes and only its outline changes to hold the edge against the
        // background.
        signalHousing: '#334155',
        signalHousingEdge: 'rgba(255, 255, 255, 0.5)',
        signalLensOff: ['#7f2d33', '#7d6220', '#256b47'],
        label: '#0f172a',
        labelMuted: '#64748b',
        labelBg: 'rgba(255, 255, 255, 0.86)',
        dimension: 'rgba(100, 116, 139, 0.55)',
        highlight: '#b45309',
        hud: 'rgba(30, 41, 59, 0.75)',
        junctionInner: 'rgba(15, 23, 42, 0.08)',
        // Sprite variety (build step 11): a handful of body colours cars are
        // drawn from, picked per-car by the seeded PRNG so the road doesn't
        // read as a line of identical clones. Brake lights (carStopped) always
        // override this - the stop/go signal has to stay legible regardless of
        // which body colour a given car happens to be.
        carPalette: ['#1e293b', '#334155', '#3f3527', '#1f3a4d'],
        // One colour per truck size (small/medium/large, see car.js's
        // TRUCK_VEHICLE_TYPES) - warm tones deliberately distinct from the cool
        // car palette above, so a truck reads as a different vehicle class at a
        // glance, not just a bigger car. Darkens with size.
        truckPalette: ['#b45309', '#9a3412', '#7c2d12'],
        carStopped: '#dc2626',
        carEdge: 'rgba(255, 255, 255, 0.65)',
    },
    dark: {
        void: '#080d16',
        groundGrid: 'rgba(148, 163, 184, 0.05)',
        asphalt: '#2a3444',
        asphaltEdge: '#3f4b60',
        junction: '#343f54',
        junctionEdge: '#4b586f',
        laneDash: 'rgba(226, 232, 240, 0.30)',
        edgeLine: 'rgba(226, 232, 240, 0.45)',
        centreLine: '#c9a227',
        stopLine: 'rgba(241, 245, 249, 0.9)',
        arrow: 'rgba(226, 232, 240, 0.42)',
        signalHousing: '#0b1220',
        signalHousingEdge: 'rgba(226, 232, 240, 0.24)',
        signalLensOff: ['#6d262d', '#6b531b', '#1d5c3c'],
        label: '#e2e8f0',
        labelMuted: '#94a3b8',
        labelBg: 'rgba(8, 13, 22, 0.78)',
        dimension: 'rgba(148, 163, 184, 0.5)',
        highlight: '#facc15',
        hud: 'rgba(226, 232, 240, 0.7)',
        junctionInner: 'rgba(226, 232, 240, 0.10)',
        carPalette: ['#e2e8f0', '#cbd5e1', '#e8dcc8', '#c9dcea'],
        truckPalette: ['#fcd34d', '#fb923c', '#f97316'],
        carStopped: '#f87171',
        carEdge: 'rgba(8, 13, 22, 0.65)',
    },
};

/** Bright lit-lens colours - universal traffic-light hues, not theme-dependent. */
const LIT_LENS_COLOURS = ['#ef4444', '#f59e0b', '#22c55e'];

/**
 * Active palette. Reassigning this module-level binding re-themes every draw
 * call, because they all read `PALETTE.x` at paint time.
 */
let PALETTE = PALETTES.light;

export function setRendererTheme(theme) {
    PALETTE = PALETTES[theme] ?? PALETTES.light;
}

const MAX_SCALE = 14; // px per metre
const MIN_SCALE_FACTOR = 0.6; // relative to the fit scale

/* ------------------------------------------------------------------ camera */

export class Camera {
    constructor() {
        this.centre = { x: 0, y: 0 };
        this.scale = 1;
        this.fitScale = 1;
        this.viewport = { width: 1, height: 1 };
    }

    setViewport(width, height) {
        this.viewport = { width, height };
    }

    /**
     * Recompute the scale that would show all of `bounds`, without adopting it.
     * Called on resize so the zoom-out limit tracks the viewport.
     */
    measureFit(bounds, paddingPx = 48) {
        const { width, height } = this.viewport;
        const usableW = Math.max(1, width - paddingPx * 2);
        const usableH = Math.max(1, height - paddingPx * 2);
        this.fitScale = Math.min(usableW / Math.max(bounds.widthM, 1), usableH / Math.max(bounds.heightM, 1));
        return this.fitScale;
    }

    /** Compute and adopt the scale that shows all of `bounds` with padding. */
    fit(bounds, paddingPx = 48) {
        this.measureFit(bounds, paddingPx);
        this.scale = Math.min(this.fitScale, MAX_SCALE);
        this.centre = {
            x: (bounds.minX + bounds.maxX) / 2,
            y: (bounds.minY + bounds.maxY) / 2,
        };
        return this;
    }

    get minScale() {
        return this.fitScale * MIN_SCALE_FACTOR;
    }

    clampScale(scale) {
        return Math.min(MAX_SCALE, Math.max(this.minScale, scale));
    }

    toScreen(p) {
        return {
            x: (p.x - this.centre.x) * this.scale + this.viewport.width / 2,
            y: (p.y - this.centre.y) * this.scale + this.viewport.height / 2,
        };
    }

    toWorld(p) {
        return {
            x: (p.x - this.viewport.width / 2) / this.scale + this.centre.x,
            y: (p.y - this.viewport.height / 2) / this.scale + this.centre.y,
        };
    }

    /** Zoom by `factor`, keeping the world point under `screenPt` pinned. */
    zoomAt(screenPt, factor) {
        const before = this.toWorld(screenPt);
        this.scale = this.clampScale(this.scale * factor);
        const after = this.toWorld(screenPt);
        this.centre.x += before.x - after.x;
        this.centre.y += before.y - after.y;
    }

    panByPixels(dx, dy) {
        this.centre.x -= dx / this.scale;
        this.centre.y -= dy / this.scale;
    }

    centreOn(point, scale = null) {
        this.centre = { x: point.x, y: point.y };
        if (scale !== null) this.scale = this.clampScale(scale);
    }
}

/* ---------------------------------------------------------------- renderer */

export class LayoutRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.camera = new Camera();
        this.layout = null;
        this.dpr = 1;
        this.hoverNodeId = null;
        /** Per-frame simulation state (build step 2+): live cars and signal phases, set by simulator.js each frame. */
        this.dynamic = { cars: [], signals: new Map() };
        this.options = {
            showLabels: true,
            showLaneMarkings: true,
            showDistances: true,
            showSignalHeads: true,
        };
    }

    setLayout(layout, { refit = true } = {}) {
        this.layout = layout;
        this.hoverNodeId = null;
        this.resize({ refit });
        return this;
    }

    setOptions(partial) {
        Object.assign(this.options, partial);
    }

    /** `{ cars: [{point, stopped, heading}], signals: Map<nodeId, {dark, arterialGreen, arterialYellow, crossGreen, crossYellow}> }` */
    setDynamicState(dynamic) {
        this.dynamic = dynamic;
    }

    /** Swap the map palette and repaint. Called on every theme toggle. */
    setTheme(theme) {
        setRendererTheme(theme);
        this.draw();
        return this;
    }

    /** Sync the backing store to the element's CSS size and device pixel ratio. */
    resize({ refit = false } = {}) {
        const rect = this.canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);

        this.canvas.width = Math.round(width * this.dpr);
        this.canvas.height = Math.round(height * this.dpr);
        this.camera.setViewport(width, height);

        if (this.layout) {
            if (refit) {
                this.camera.fit(this.layout.bounds);
            } else {
                // Keep the current zoom but re-derive the zoom-out limit.
                this.camera.measureFit(this.layout.bounds);
                this.camera.scale = this.camera.clampScale(this.camera.scale);
            }
        }
        this.draw();
    }

    fit() {
        if (!this.layout) return;
        this.camera.fit(this.layout.bounds);
        this.draw();
    }

    /** Nearest intersection within `radiusPx` of a screen point, or null. */
    hitTestIntersection(screenPt, radiusPx = 26) {
        if (!this.layout) return null;
        let best = null;
        let bestDist = radiusPx;
        for (const arterial of this.layout.arterials) {
            for (const node of arterial.intersections) {
                const s = this.camera.toScreen(node.point);
                const d = Math.hypot(s.x - screenPt.x, s.y - screenPt.y);
                if (d < bestDist) {
                    bestDist = d;
                    best = node;
                }
            }
        }
        return best;
    }

    /* ------------------------------------------------------------- drawing */

    draw() {
        const { ctx } = this;
        const { width, height } = this.camera.viewport;

        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        // Camera state mirrored onto the element so it is inspectable from tests
        // and dev tools without reaching into the module. Guarded so the Phase 2
        // render loop is not writing a DOM attribute every frame.
        const scaleAttr = this.camera.scale.toFixed(3);
        if (this.canvas.dataset.scale !== scaleAttr) this.canvas.dataset.scale = scaleAttr;

        this.drawBackground(width, height);

        if (!this.layout) {
            this.drawPlaceholder(width, height);
            return;
        }

        // Asphalt first, then markings, then junction boxes on top so no lane
        // marking bleeds through a junction, then furniture and labels.
        this.drawRoadSurfaces();
        if (this.options.showLaneMarkings) this.drawRoadMarkings();
        this.drawJunctions();
        this.drawStopLines();
        this.drawCars();
        if (this.options.showSignalHeads) this.drawSignalHeads();
        if (this.options.showDistances) this.drawDistanceAnnotations();
        if (this.options.showLabels) this.drawLabels();
        this.drawHover();
        this.drawScaleBar(height);
        this.drawCompass(width);
    }

    drawBackground(width, height) {
        const { ctx } = this;
        ctx.fillStyle = PALETTE.void;
        ctx.fillRect(0, 0, width, height);

        if (!this.layout) return;

        // Faint 100 m graticule so pan/zoom has a sense of scale.
        const stepM = niceStep(100 / this.camera.scale);
        const step = stepM * this.camera.scale;
        if (step < 12) return;

        const originScreen = this.camera.toScreen({ x: 0, y: 0 });
        ctx.strokeStyle = PALETTE.groundGrid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = originScreen.x % step; x < width; x += step) {
            ctx.moveTo(Math.round(x) + 0.5, 0);
            ctx.lineTo(Math.round(x) + 0.5, height);
        }
        for (let y = originScreen.y % step; y < height; y += step) {
            ctx.moveTo(0, Math.round(y) + 0.5);
            ctx.lineTo(width, Math.round(y) + 0.5);
        }
        ctx.stroke();
    }

    drawPlaceholder(width, height) {
        const { ctx } = this;
        ctx.fillStyle = PALETTE.labelMuted;
        ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No corridor loaded.', width / 2, height / 2);
        ctx.textAlign = 'left';
    }

    /** Every road, drawn as a thick capped line along its centreline. */
    eachRoad(callback) {
        for (const arterial of this.layout.arterials) {
            callback({
                from: arterial.startPoint,
                to: arterial.endPoint,
                widthM: arterial.roadWidthM,
                lanes: arterial.lanes,
                twoWay: false,
                heading: arterial.heading,
                ref: arterial,
                kind: 'arterial',
            });
        }
        for (const connector of this.layout.connectors) {
            callback({
                from: connector.startPoint,
                to: connector.endPoint,
                widthM: connector.roadWidthM,
                lanes: connector.lanes,
                twoWay: connector.twoWay,
                heading: connector.heading,
                ref: connector,
                kind: 'connector',
            });
        }
        for (const arterial of this.layout.arterials) {
            for (const node of arterial.intersections) {
                if (!node.crossStub) continue;
                callback({
                    from: node.crossStub.startPoint,
                    to: node.crossStub.endPoint,
                    widthM: node.crossRoadWidthM,
                    lanes: node.crossLanes,
                    twoWay: node.crossTwoWay,
                    heading: node.crossAxis,
                    ref: node,
                    kind: 'crossStub',
                });
            }
        }
    }

    drawRoadSurfaces() {
        const { ctx } = this;
        const { scale } = this.camera;

        this.eachRoad(({ from, to, widthM }) => {
            const a = this.camera.toScreen(from);
            const b = this.camera.toScreen(to);
            const w = Math.max(2, widthM * scale);

            ctx.strokeStyle = PALETTE.asphaltEdge;
            ctx.lineWidth = w + Math.min(3, Math.max(1, scale * 0.5));
            ctx.lineCap = 'butt';
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();

            ctx.strokeStyle = PALETTE.asphalt;
            ctx.lineWidth = w;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        });
    }

    drawRoadMarkings() {
        const { scale } = this.camera;
        if (scale < 0.7) return; // markings would be sub-pixel mush

        this.eachRoad(({ from, to, widthM, lanes, twoWay, heading }) => {
            const normal = { x: -heading.y, y: heading.x };
            const half = widthM / 2;
            const laneWidthM = widthM / lanes;

            // Edge lines always; anything drawn between lanes only once a lane is
            // wide enough on screen to read as a lane rather than as noise.
            for (const off of [-half, half]) {
                this.strokeOffsetLine(from, to, normal, off, PALETTE.edgeLine, 1, null);
            }
            if (laneWidthM * scale < 7) return;

            if (twoWay) {
                // Solid centreline separating the two directions of travel.
                this.strokeOffsetLine(from, to, normal, 0, PALETTE.centreLine, 1.6, null);
                // Interior lane divisions within each direction.
                const perSide = lanes / 2;
                for (let i = 1; i < perSide; i += 1) {
                    const off = i * laneWidthM;
                    this.strokeOffsetLine(from, to, normal, off, PALETTE.laneDash, 1.2, [7, 9]);
                    this.strokeOffsetLine(from, to, normal, -off, PALETTE.laneDash, 1.2, [7, 9]);
                }
            } else {
                for (let i = 1; i < lanes; i += 1) {
                    const off = -half + i * laneWidthM;
                    this.strokeOffsetLine(from, to, normal, off, PALETTE.laneDash, 1.2, [7, 9]);
                }
            }
        });

        if (scale >= 2.2) this.drawDirectionArrows();
    }

    strokeOffsetLine(from, to, normal, offsetM, colour, lineWidth, dash) {
        const { ctx } = this;
        const a = this.camera.toScreen({ x: from.x + normal.x * offsetM, y: from.y + normal.y * offsetM });
        const b = this.camera.toScreen({ x: to.x + normal.x * offsetM, y: to.y + normal.y * offsetM });
        ctx.save();
        ctx.strokeStyle = colour;
        ctx.lineWidth = lineWidth;
        if (dash) ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
    }

    drawDirectionArrows() {
        const { scale } = this.camera;
        const spacingM = niceStep(140 / scale);

        for (const arterial of this.layout.arterials) {
            const offsets = laneCentreOffsetsFor(arterial.roadWidthM, arterial.lanes, false);
            this.arrowsAlong(arterial.startPoint, arterial.centrelineLengthM, arterial.heading, offsets, spacingM);
        }
        for (const connector of this.layout.connectors) {
            const perSide = Math.max(1, Math.floor(connector.lanes / 2));
            const offsets = laneCentreOffsetsFor(connector.roadWidthM, connector.lanes, true).slice(0, perSide);
            const length = connector.spanM + connector.stubLengthM * 2;
            this.arrowsAlong(connector.startPoint, length, connector.heading, offsets, spacingM);
            this.arrowsAlong(
                connector.endPoint,
                length,
                { x: -connector.heading.x, y: -connector.heading.y },
                offsets,
                spacingM
            );
        }
    }

    arrowsAlong(start, lengthM, heading, laneOffsets, spacingM) {
        const { ctx } = this;
        const { scale } = this.camera;
        const left = { x: heading.y, y: -heading.x };
        const sizePx = Math.min(11, Math.max(4, scale * 2.2));

        ctx.save();
        ctx.strokeStyle = PALETTE.arrow;
        ctx.lineWidth = Math.min(2, Math.max(1, scale * 0.35));
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let s = spacingM * 0.5; s < lengthM; s += spacingM) {
            for (const off of laneOffsets) {
                const world = {
                    x: start.x + heading.x * s + left.x * off,
                    y: start.y + heading.y * s + left.y * off,
                };
                const p = this.camera.toScreen(world);
                if (p.x < -20 || p.y < -20 || p.x > this.camera.viewport.width + 20 || p.y > this.camera.viewport.height + 20) {
                    continue;
                }
                const tip = { x: p.x + heading.x * sizePx, y: p.y + heading.y * sizePx };
                const back = { x: p.x - heading.x * sizePx, y: p.y - heading.y * sizePx };
                ctx.moveTo(back.x, back.y);
                ctx.lineTo(tip.x, tip.y);
                ctx.moveTo(tip.x, tip.y);
                ctx.lineTo(tip.x - heading.x * sizePx * 0.7 + left.x * sizePx * 0.5, tip.y - heading.y * sizePx * 0.7 + left.y * sizePx * 0.5);
                ctx.moveTo(tip.x, tip.y);
                ctx.lineTo(tip.x - heading.x * sizePx * 0.7 - left.x * sizePx * 0.5, tip.y - heading.y * sizePx * 0.7 - left.y * sizePx * 0.5);
            }
        }
        ctx.stroke();
        ctx.restore();
    }

    drawJunctions() {
        const { ctx } = this;
        const { scale } = this.camera;

        for (const arterial of this.layout.arterials) {
            for (const node of arterial.intersections) {
                // Union of two rectangles - one aligned to the arterial, one to the
                // cross street - so a skewed connector is still covered.
                const rects = [
                    { axis: arterial.heading, along: node.crossRoadWidthM, across: node.arterialRoadWidthM },
                    { axis: node.crossAxis, along: node.arterialRoadWidthM, across: node.crossRoadWidthM },
                ];
                for (const rect of rects) {
                    ctx.save();
                    ctx.fillStyle = PALETTE.junction;
                    ctx.strokeStyle = PALETTE.junctionEdge;
                    ctx.lineWidth = 1;
                    this.pathRotatedRect(node.point, rect.axis, rect.along, rect.across);
                    ctx.fill();
                    ctx.restore();
                }

                if (scale > 2.4) {
                    ctx.save();
                    ctx.strokeStyle = PALETTE.junctionInner;
                    ctx.lineWidth = 1;
                    this.pathRotatedRect(node.point, arterial.heading, node.crossRoadWidthM, node.arterialRoadWidthM);
                    ctx.stroke();
                    ctx.restore();
                }
            }
        }
    }

    pathRotatedRect(centre, axis, alongM, acrossM) {
        const { ctx } = this;
        const normal = { x: -axis.y, y: axis.x };
        const ha = alongM / 2;
        const hb = acrossM / 2;
        const corners = [
            { x: centre.x + axis.x * ha + normal.x * hb, y: centre.y + axis.y * ha + normal.y * hb },
            { x: centre.x + axis.x * ha - normal.x * hb, y: centre.y + axis.y * ha - normal.y * hb },
            { x: centre.x - axis.x * ha - normal.x * hb, y: centre.y - axis.y * ha - normal.y * hb },
            { x: centre.x - axis.x * ha + normal.x * hb, y: centre.y - axis.y * ha + normal.y * hb },
        ].map((p) => this.camera.toScreen(p));

        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < corners.length; i += 1) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
    }

    drawStopLines() {
        const { ctx } = this;
        const { scale } = this.camera;
        if (scale < 0.8) return;

        ctx.save();
        ctx.strokeStyle = PALETTE.stopLine;
        ctx.lineWidth = Math.min(5, Math.max(1.5, scale * 0.55));
        ctx.lineCap = 'butt';
        ctx.beginPath();
        for (const arterial of this.layout.arterials) {
            for (const node of arterial.intersections) {
                for (const approach of node.approaches) {
                    const a = this.camera.toScreen(approach.stopLine.a);
                    const b = this.camera.toScreen(approach.stopLine.b);
                    ctx.moveTo(a.x, a.y);
                    ctx.lineTo(b.x, b.y);
                }
            }
        }
        ctx.stroke();
        ctx.restore();
    }

    /**
     * Cars, drawn as small rotated rounded rectangles oriented along their
     * arterial's heading. Drawn after the road/junction surfaces and before the
     * signal heads/labels, so vehicles sit "on" the asphalt but furniture and
     * text stay legible on top.
     */
    drawCars() {
        const cars = this.dynamic.cars;
        if (!cars?.length) return;

        const { ctx } = this;
        const { scale, viewport } = this.camera;
        const defaultLengthM = this.layout.carLengthM ?? 4.5;
        const defaultWidthM = Math.min(2.0, this.layout.laneWidthM * 0.55);

        ctx.save();
        ctx.strokeStyle = PALETTE.carEdge;
        ctx.lineWidth = 1;

        for (const car of cars) {
            const p = this.camera.toScreen(car.point);
            if (p.x < -20 || p.y < -20 || p.x > viewport.width + 20 || p.y > viewport.height + 20) continue;

            // Same screen-space floor/ceiling treatment as the signal heads
            // (drawSignalHeads, below): a real 4.5m car is a couple of px at the
            // network-overview zoom, which reads as noise rather than a vehicle.
            // Floor keeps it visible zoomed out; ceiling stops it overgrowing a
            // lane once zoomed in close. Trucks (car.lengthM/widthM from
            // car.js's VEHICLE_TYPES) get a taller ceiling so a large rig still
            // reads as visibly longer than a car once zoomed in.
            const lengthM = car.lengthM ?? defaultLengthM;
            const widthM = car.widthM ?? defaultWidthM;
            const lengthPx = Math.min(34, Math.max(6, lengthM * scale));
            const widthPx = Math.min(13, Math.max(3.5, widthM * scale));
            const cornerPx = Math.min(2, widthPx / 3);

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(Math.atan2(car.heading.y, car.heading.x));
            ctx.fillStyle = car.stopped ? PALETTE.carStopped : vehicleFillColour(car);
            roundRect(ctx, -lengthPx / 2, -widthPx / 2, lengthPx, widthPx, cornerPx);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }

        ctx.restore();
    }

    /**
     * Signal heads. Unlit (all three lenses equally dim) when there is no
     * dynamic state yet, or when `signals.get(node.id).dark` is true (load
     * shedding, build step 6) - that dimness is deliberate, it is how an
     * unpowered head actually looks and cannot be mistaken for a phase, since
     * no single lens is brighter than the others.
     *
     * These are MAP SYMBOLS, not world-scale objects. A real signal lens is about
     * 0.3 m across, which is sub-pixel at any zoom you would actually watch the
     * whole corridor at, so the head is drawn at a near-constant screen size that
     * grows only gently with zoom - the same treatment a map pin gets. Without
     * that floor they are invisible until you are zoomed right in.
     */
    drawSignalHeads() {
        const { ctx } = this;
        const { scale } = this.camera;
        // Low enough that heads are already visible in the default fit view.
        if (scale < 0.4) return;

        // Screen-space floor of 3.1 px per lens, ceiling so it stops growing once
        // it reads clearly; the world scale only nudges it in between.
        const r = Math.min(6.5, Math.max(3.1, scale * 0.62));
        const gap = r * 2.2;
        const housingW = r * 3.1;
        const housingH = gap * 3 + r * 1.2;
        const radius = Math.min(3.5, r * 0.7);
        const lensR = r * 0.74;

        ctx.save();
        ctx.lineWidth = 1;

        for (const arterial of this.layout.arterials) {
            for (const node of arterial.intersections) {
                const signal = this.dynamic.signals.get(node.id) ?? null;

                for (const approach of node.approaches) {
                    const p = this.camera.toScreen(approach.signalHead);
                    // Cheap cull: skip heads that are off screen entirely.
                    if (
                        p.x < -housingW ||
                        p.y < -housingH ||
                        p.x > this.camera.viewport.width + housingW ||
                        p.y > this.camera.viewport.height + housingH
                    ) {
                        continue;
                    }

                    ctx.fillStyle = PALETTE.signalHousing;
                    ctx.strokeStyle = PALETTE.signalHousingEdge;
                    roundRect(ctx, p.x - housingW / 2, p.y - housingH / 2, housingW, housingH, radius);
                    ctx.fill();
                    ctx.stroke();

                    const litIndex = litLensIndexFor(approach, signal);
                    for (let i = 0; i < 3; i += 1) {
                        ctx.fillStyle = i === litIndex ? LIT_LENS_COLOURS[i] : PALETTE.signalLensOff[i];
                        ctx.beginPath();
                        ctx.arc(p.x, p.y - gap + i * gap, lensR, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            }
        }

        ctx.restore();
    }

    /**
     * Inter-intersection distances. These are the numbers the green wave offset
     * chain divides by target speed, so showing them makes the coordination
     * story legible before any of it is computed.
     */
    drawDistanceAnnotations() {
        const { ctx } = this;
        const { scale } = this.camera;
        if (scale < 0.55) return;

        ctx.save();
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (const arterial of this.layout.arterials) {
            const normal = { x: -arterial.heading.y, y: arterial.heading.x };
            const offsetM = arterial.roadWidthM / 2 + 9;

            for (let i = 0; i < arterial.intersections.length - 1; i += 1) {
                const node = arterial.intersections[i];
                const next = arterial.intersections[i + 1];
                if (!node.distanceToNextM) continue;

                const mid = {
                    x: (node.point.x + next.point.x) / 2 + normal.x * offsetM,
                    y: (node.point.y + next.point.y) / 2 + normal.y * offsetM,
                };
                const from = { x: node.point.x + normal.x * offsetM, y: node.point.y + normal.y * offsetM };
                const to = { x: next.point.x + normal.x * offsetM, y: next.point.y + normal.y * offsetM };

                const sa = this.camera.toScreen(from);
                const sb = this.camera.toScreen(to);
                const sm = this.camera.toScreen(mid);
                if (Math.hypot(sb.x - sa.x, sb.y - sa.y) < 54) continue;

                ctx.strokeStyle = PALETTE.dimension;
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 4]);
                ctx.beginPath();
                ctx.moveTo(sa.x, sa.y);
                ctx.lineTo(sb.x, sb.y);
                ctx.stroke();
                ctx.setLineDash([]);

                const text = `${node.distanceToNextM} m`;
                const w = ctx.measureText(text).width + 8;
                ctx.fillStyle = PALETTE.labelBg;
                roundRect(ctx, sm.x - w / 2, sm.y - 8, w, 16, 4);
                ctx.fill();
                ctx.fillStyle = PALETTE.labelMuted;
                ctx.fillText(text, sm.x, sm.y);
            }
        }
        ctx.restore();
    }

    drawLabels() {
        const { ctx } = this;
        const { scale } = this.camera;

        ctx.save();
        ctx.textBaseline = 'middle';

        // Connector / cross-street names, set at the top end of each connector.
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        for (const connector of this.layout.connectors) {
            const p = this.camera.toScreen(connector.startPoint);
            const q = this.camera.toScreen(connector.endPoint);
            const anchor = p.y <= q.y ? p : q;
            this.pill(connector.name, anchor.x, anchor.y - 12, PALETTE.labelMuted);
        }
        for (const arterial of this.layout.arterials) {
            for (const node of arterial.intersections) {
                if (!node.crossStub) continue;
                const p = this.camera.toScreen(node.crossStub.startPoint);
                const q = this.camera.toScreen(node.crossStub.endPoint);
                const anchor = p.y <= q.y ? p : q;
                this.pill(node.crossStreetName, anchor.x, anchor.y - 12, PALETTE.labelMuted);
            }
        }

        // Intersection names, offset clear of the carriageway on the side facing
        // away from the rest of the network, so two parallel arterials never
        // collide labels in the block between them.
        if (scale > 0.5) {
            ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
            this.layout.arterials.forEach((arterial, ai) => {
                const accent = ARTERIAL_ACCENTS[ai % ARTERIAL_ACCENTS.length];
                const normal = { x: -arterial.heading.y, y: arterial.heading.x };
                const side = this.outwardSide(arterial);
                const offM = arterial.roadWidthM / 2 + 26;

                for (const node of arterial.intersections) {
                    const world = {
                        x: node.point.x + normal.x * offM * side,
                        y: node.point.y + normal.y * offM * side,
                    };
                    const p = this.camera.toScreen(world);
                    this.pill(node.name, p.x, p.y, PALETTE.label, accent);
                }
            });
        }

        // Arterial name banners: one row further out than the intersection names,
        // at the arterial's entry point, clamped so a long banner never runs off
        // the edge of the view.
        ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
        this.layout.arterials.forEach((arterial, ai) => {
            const accent = ARTERIAL_ACCENTS[ai % ARTERIAL_ACCENTS.length];
            const normal = { x: -arterial.heading.y, y: arterial.heading.x };
            const side = this.outwardSide(arterial);
            const offM = arterial.roadWidthM / 2 + 52;
            const world = {
                x: arterial.startPoint.x + arterial.heading.x * 30 + normal.x * offM * side,
                y: arterial.startPoint.y + arterial.heading.y * 30 + normal.y * offM * side,
            };
            const p = this.camera.toScreen(world);
            // Clamp horizontally so a long banner is never cut off, but let it drop
            // out of view vertically rather than pinning it over the scale bar.
            if (p.y < 14 || p.y > this.camera.viewport.height - 30) return;
            const text = `${arterial.name}  ·  ${arterial.lanes} lanes  ·  ${arterial.targetSpeedKph} km/h`;
            this.pill(text, p.x, p.y, PALETTE.label, accent, { clampX: true });
        });

        ctx.restore();
    }

    /**
     * +1 or -1: which side of an arterial faces away from the network centre.
     * Labels go on that side.
     */
    outwardSide(arterial) {
        const b = this.layout.bounds;
        const centre = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
        const mid = {
            x: (arterial.startPoint.x + arterial.endPoint.x) / 2,
            y: (arterial.startPoint.y + arterial.endPoint.y) / 2,
        };
        const normal = { x: -arterial.heading.y, y: arterial.heading.x };
        const dot = (mid.x - centre.x) * normal.x + (mid.y - centre.y) * normal.y;
        return dot >= 0 ? 1 : -1;
    }

    /** Small rounded label with a dark backing so text stays readable over asphalt. */
    pill(text, cx, cy, colour, dotColour = null, { clampX = false } = {}) {
        const { ctx } = this;
        const padX = dotColour ? 16 : 7;
        const w = ctx.measureText(text).width + padX + 7;
        const h = 18;

        if (clampX) {
            const { width } = this.camera.viewport;
            cx = Math.min(Math.max(cx, w / 2 + 6), Math.max(w / 2 + 6, width - w / 2 - 6));
        }

        ctx.fillStyle = PALETTE.labelBg;
        roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 5);
        ctx.fill();
        if (dotColour) {
            ctx.fillStyle = dotColour;
            ctx.beginPath();
            ctx.arc(cx - w / 2 + 8, cy, 3, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.fillStyle = colour;
        const prevAlign = ctx.textAlign;
        ctx.textAlign = 'left';
        ctx.fillText(text, cx - w / 2 + padX, cy + 0.5);
        ctx.textAlign = prevAlign;
    }

    drawHover() {
        if (!this.hoverNodeId) return;
        const node = this.layout.nodesById.get(this.hoverNodeId);
        if (!node) return;

        const { ctx } = this;
        const p = this.camera.toScreen(node.point);
        const r = Math.max(14, (Math.max(node.crossRoadWidthM, node.arterialRoadWidthM) / 2) * this.camera.scale + 6);

        ctx.save();
        ctx.strokeStyle = PALETTE.highlight;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    drawScaleBar(height) {
        const { ctx } = this;
        const targetPx = 130;
        const metres = niceStep(targetPx / this.camera.scale);
        const px = metres * this.camera.scale;
        const x = 16;
        const y = height - 20;

        ctx.save();
        ctx.strokeStyle = PALETTE.hud;
        ctx.fillStyle = PALETTE.hud;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x, y);
        ctx.lineTo(x + px, y);
        ctx.lineTo(x + px, y - 5);
        ctx.stroke();
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(`${metres} m`, x, y - 9);
        ctx.fillText(`${this.camera.scale.toFixed(2)} px/m`, x + px + 10, y - 1);
        ctx.restore();
    }

    drawCompass(width) {
        const { ctx } = this;
        const x = width - 28;
        const y = 28;
        ctx.save();
        ctx.strokeStyle = PALETTE.hud;
        ctx.fillStyle = PALETTE.hud;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, y + 9);
        ctx.lineTo(x, y - 9);
        ctx.moveTo(x - 4, y - 4);
        ctx.lineTo(x, y - 9);
        ctx.lineTo(x + 4, y - 4);
        ctx.stroke();
        ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('N', x, y + 11);
        ctx.restore();
    }
}

/* ------------------------------------------------------------------ helpers */

function laneCentreOffsetsFor(roadWidthM, lanes, twoWay) {
    const laneWidthM = roadWidthM / lanes;
    const offsets = [];
    const count = twoWay ? Math.max(1, Math.floor(lanes / 2)) : lanes;
    for (let i = 0; i < count; i += 1) {
        offsets.push(roadWidthM / 2 - (i + 0.5) * laneWidthM);
    }
    return offsets;
}

/** Small/medium/large - must match car.js's TRUCK_VEHICLE_TYPES order, which is what PALETTE.truckPalette is indexed by. Kept local rather than imported so this file stays a pure consumer of plain snapshot objects (see the file header). */
const TRUCK_SIZE_INDEX = { truck_small: 0, truck_medium: 1, truck_large: 2 };

/** Body colour for a moving (non-stopped) vehicle: truck size palette for trucks, the usual per-car sprite-variety palette otherwise. */
function vehicleFillColour(car) {
    const truckIndex = TRUCK_SIZE_INDEX[car.vehicleType];
    if (truckIndex != null) return PALETTE.truckPalette[truckIndex];
    return PALETTE.carPalette[(car.colourIndex ?? 0) % PALETTE.carPalette.length];
}

/** Lens index (0 red, 1 amber, 2 green) that should be lit for this approach, or -1 for unlit/dark. */
function litLensIndexFor(approach, signal) {
    if (!signal || signal.dark) return -1;
    const green = approach.kind === 'arterial' ? signal.arterialGreen : signal.crossGreen;
    const yellow = approach.kind === 'arterial' ? signal.arterialYellow : signal.crossYellow;
    if (green) return 2;
    if (yellow) return 1;
    return 0;
}

/** Round a raw span up to the nearest 1/2/5 x 10^n, for grid and scale bar. */
function niceStep(raw) {
    const exp = Math.floor(Math.log10(Math.max(raw, 1e-6)));
    const base = 10 ** exp;
    const mantissa = raw / base;
    if (mantissa <= 1) return base;
    if (mantissa <= 2) return 2 * base;
    if (mantissa <= 5) return 5 * base;
    return 10 * base;
}

function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}
