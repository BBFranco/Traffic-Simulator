/**
 * /builder page script - a from-scratch road network editor.
 *
 * Roads are plain line segments the user places by dragging a palette tile
 * onto the canvas, or by dragging out from an existing road's connection
 * point (every 10 m along it) to branch a new one at any angle. Two roads
 * that share or cross a point get a junction plate drawn over the seam, so a
 * connection reads as a real intersection instead of two strokes overlapping
 * (the original version of this tool just let roads cross with no plate,
 * which looked like a rendering glitch rather than a joined network).
 *
 * There is no camera/pan-zoom here yet (unlike the simulator's canvas) -
 * everything is drawn 1:1 in canvas pixels, with 6 px standing for 1 m, which
 * is what fixes the connection-point spacing at 60 px (10 m).
 */

import { onThemeChange } from './theme.js';

const PALETTES = {
    light: {
        void: '#f8fafc',
        asphalt: '#d1d9e2',
        asphaltEdge: '#9aa6b6',
        laneDash: 'rgba(51, 65, 85, 0.40)',
        centreLine: '#b45309',
        junction: '#e6ebf1',
        junctionEdge: '#94a3b8',
        pointFill: '#ffffff',
        pointBorder: '#64748b',
        accent: '#0284c7',
    },
    dark: {
        void: '#080d16',
        asphalt: '#2a3444',
        asphaltEdge: '#3f4b60',
        laneDash: 'rgba(226, 232, 240, 0.30)',
        centreLine: '#c9a227',
        junction: '#343f54',
        junctionEdge: '#4b586f',
        pointFill: '#0f172a',
        pointBorder: '#94a3b8',
        accent: '#0ea5e9',
    },
};

const GHOST_LEN = 170; // px - length of a freshly dragged branch, ~28 m at 6 px/m
const SNAP_STEP = 15; // degrees
const SNAP_TOLERANCE = 4; // degrees
const JUNCTION_MERGE_TOL = 6; // px
const JUNCTION_HIT_TOL = 5; // px
const LANE_WIDTH_PX = 11;
const POINT_SPACING_PX = 60; // 10 m at 6 px/m
const POINT_HIT_RADIUS = 9;

function initialRoads() {
    return [
        { id: 'seed', x1: 90, y1: 170, x2: 570, y2: 170, type: 'twoway', lanes: 4 },
        { id: 'ramp1', x1: 210, y1: 170, x2: 354, y2: 80, type: 'oneway', lanes: 2 },
    ];
}

/* --------------------------------------------------------------- geometry */

/** A point is a T-junction against a segment when it lands on that segment's interior (not near either end - a true endpoint match is handled by proximity merging in computeJunctions). */
function pointOnSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    const t = ((px - x1) * dx + (py - y1) * dy) / len2;
    if (t < 0.02 || t > 0.98) return null;
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    if (Math.hypot(px - projX, py - projY) > JUNCTION_HIT_TOL) return null;
    return { x: projX, y: projY };
}

/** True X-crossing between two segments' interiors (neither endpoint involved). */
function segmentCrossing(a, b) {
    const d1x = a.x2 - a.x1;
    const d1y = a.y2 - a.y1;
    const d2x = b.x2 - b.x1;
    const d2y = b.y2 - b.y1;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-6) return null;
    const t = ((b.x1 - a.x1) * d2y - (b.y1 - a.y1) * d2x) / denom;
    const u = ((b.x1 - a.x1) * d1y - (b.y1 - a.y1) * d1x) / denom;
    if (t < 0.02 || t > 0.98 || u < 0.02 || u > 0.98) return null;
    return { x: a.x1 + t * d1x, y: a.y1 + t * d1y };
}

/** Every point where two placed roads actually meet - T-junctions (the normal case, since every branch starts on another road's connection point), X-crossings and matching endpoints all fall out of the same pairwise check. */
function computeJunctions(roads) {
    const nodes = [];
    const addNode = (x, y, width) => {
        let node = nodes.find((n) => Math.hypot(n.x - x, n.y - y) < JUNCTION_MERGE_TOL);
        if (!node) {
            node = { x, y, width };
            nodes.push(node);
        }
        node.width = Math.max(node.width, width);
    };

    for (let i = 0; i < roads.length; i += 1) {
        for (let j = i + 1; j < roads.length; j += 1) {
            const a = roads[i];
            const b = roads[j];
            const w = Math.max(a.roadWidth, b.roadWidth);
            const hits = [
                pointOnSegment(a.x1, a.y1, b.x1, b.y1, b.x2, b.y2),
                pointOnSegment(a.x2, a.y2, b.x1, b.y1, b.x2, b.y2),
                pointOnSegment(b.x1, b.y1, a.x1, a.y1, a.x2, a.y2),
                pointOnSegment(b.x2, b.y2, a.x1, a.y1, a.x2, a.y2),
                segmentCrossing(a, b),
            ];
            for (const hit of hits) {
                if (hit) addNode(hit.x, hit.y, w);
            }
        }
    }

    return nodes.map((n) => ({ x: n.x, y: n.y, r: n.width / 2 + 6 }));
}

/** Raw placed-road record -> fully computed geometry (asphalt width, lane markings, connection points, pin anchor). */
function buildRoad(road, isSelected) {
    const dx = road.x2 - road.x1;
    const dy = road.y2 - road.y1;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const nx = -uy;
    const ny = ux;
    const roadWidth = road.lanes * LANE_WIDTH_PX;
    const edgeWidth = roadWidth + 4;

    const mkLine = (off, color, dash, sw) => ({
        x1: road.x1 + nx * off,
        y1: road.y1 + ny * off,
        x2: road.x2 + nx * off,
        y2: road.y2 + ny * off,
        color,
        dash,
        sw,
    });

    const lines = [];
    if (road.type === 'twoway') {
        lines.push(mkLine(0, 'centreLine', null, 2.4));
        const perSide = Math.max(1, Math.floor(road.lanes / 2));
        for (let i = 1; i < perSide; i += 1) {
            lines.push(mkLine(i * LANE_WIDTH_PX, 'laneDash', [9, 9], 1.3));
            lines.push(mkLine(-i * LANE_WIDTH_PX, 'laneDash', [9, 9], 1.3));
        }
    } else {
        for (let i = 1; i < road.lanes; i += 1) {
            const off = -roadWidth / 2 + i * LANE_WIDTH_PX;
            lines.push(mkLine(off, 'laneDash', [9, 9], 1.3));
        }
    }

    const points = [];
    for (let s = 0; s <= length + 1; s += POINT_SPACING_PX) {
        points.push({ x: road.x1 + ux * s, y: road.y1 + uy * s, joined: false });
    }

    const midX = (road.x1 + road.x2) / 2;
    const midY = (road.y1 + road.y2) / 2;

    return {
        id: road.id,
        x1: road.x1,
        y1: road.y1,
        x2: road.x2,
        y2: road.y2,
        type: road.type,
        lanes: road.lanes,
        roadWidth,
        edgeWidth,
        lines,
        points,
        selected: !!isSelected,
        pinX: midX - 88,
        pinY: midY - 96,
    };
}

/* ------------------------------------------------------------------ state */

const state = {
    roadType: 'twoway',
    lanes: 3,
    placedRoads: initialRoads(),
    selectedId: 'ramp1',
    dragging: { originX: 330, originY: 170, mouseX: 438, mouseY: 274, angleDeg: 45, snapped: true },
    nextId: 2,
    theme: 'light',
    /** Recomputed on every draw() - cached so pointer handlers can hit-test without rebuilding geometry. */
    builtRoads: [],
    junctions: [],
};

const el = {
    canvas: document.getElementById('builder-canvas'),
    canvasWrap: document.getElementById('builder-canvas-wrap'),
    paletteTile: document.getElementById('builder-palette-tile'),
    paletteMeta: document.getElementById('builder-palette-meta'),
    lanesValue: document.getElementById('builder-lanes-value'),
    lanesDec: document.getElementById('builder-lanes-dec'),
    lanesInc: document.getElementById('builder-lanes-inc'),
    resetButton: document.getElementById('builder-reset'),
    status: document.getElementById('builder-status'),
    roadCount: document.getElementById('builder-road-count'),
    pin: document.getElementById('builder-pin'),
    pinType: document.getElementById('builder-pin-type'),
    pinLanes: document.getElementById('builder-pin-lanes'),
    pinDone: document.getElementById('builder-pin-done'),
    angleBadge: document.getElementById('builder-angle-badge'),
};

const ctx = el.canvas.getContext('2d');
let dpr = 1;

/* ------------------------------------------------------------------ draw */

function resizeCanvas() {
    const rect = el.canvasWrap.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.canvas.width = Math.round(rect.width * dpr);
    el.canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
}

function strokeLine(x1, y1, x2, y2, color, width, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
}

function draw() {
    const pal = PALETTES[state.theme];
    const rect = el.canvasWrap.getBoundingClientRect();

    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = pal.void;
    ctx.fillRect(0, 0, rect.width, rect.height);

    const roads = state.placedRoads.map((r) => buildRoad(r, r.id === state.selectedId));
    const junctions = computeJunctions(roads);
    for (const road of roads) {
        for (const pt of road.points) {
            pt.joined = junctions.some((j) => Math.hypot(j.x - pt.x, j.y - pt.y) < 8);
        }
    }
    state.builtRoads = roads;
    state.junctions = junctions;

    // Pass 1: every road's asphalt + lane markings.
    for (const road of roads) {
        strokeLine(road.x1, road.y1, road.x2, road.y2, pal.asphaltEdge, road.edgeWidth, null);
        ctx.lineCap = 'round';
        strokeLine(road.x1, road.y1, road.x2, road.y2, pal.asphalt, road.roadWidth, null);
        ctx.lineCap = 'butt';
        if (road.selected) strokeLine(road.x1, road.y1, road.x2, road.y2, pal.accent, 2, [3, 7]);
        for (const ln of road.lines) {
            strokeLine(ln.x1, ln.y1, ln.x2, ln.y2, pal[ln.color], ln.sw, ln.dash);
        }
    }

    // Pass 2: junction plates on top of the asphalt seams, so a shared or
    // crossing point reads as one clean intersection.
    for (const j of junctions) {
        ctx.beginPath();
        ctx.arc(j.x, j.y, j.r, 0, Math.PI * 2);
        ctx.fillStyle = pal.junction;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = pal.junctionEdge;
        ctx.stroke();
    }

    // Pass 3: connection-point dots, always on top of the junction plates.
    for (const road of roads) {
        for (const pt of road.points) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 5.5, 0, Math.PI * 2);
            ctx.fillStyle = pt.joined ? pal.accent : pal.pointFill;
            ctx.fill();
            ctx.lineWidth = 1.6;
            ctx.strokeStyle = pt.joined ? pal.accent : pal.pointBorder;
            ctx.stroke();
        }
    }

    let ghostEnd = null;
    if (state.dragging) ghostEnd = drawGhost(state.dragging, pal);

    updateAngleBadge(ghostEnd);
    repositionPin();
    el.status.textContent = `${roads.length} segment${roads.length === 1 ? '' : 's'} · ${junctions.length} junction${junctions.length === 1 ? '' : 's'}`;
    el.roadCount.textContent = String(roads.length);
}

function drawGhost(d, pal) {
    ctx.save();
    ctx.strokeStyle = pal.accent;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.arc(d.originX, d.originY, GHOST_LEN, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = pal.accent;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.4;
    for (let a = 0; a < 360; a += 45) {
        const tr = (a * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(d.originX + Math.cos(tr) * (GHOST_LEN - 9), d.originY + Math.sin(tr) * (GHOST_LEN - 9));
        ctx.lineTo(d.originX + Math.cos(tr) * (GHOST_LEN + 9), d.originY + Math.sin(tr) * (GHOST_LEN + 9));
        ctx.stroke();
    }
    ctx.restore();

    const rad = (d.angleDeg * Math.PI) / 180;
    const endX = d.originX + Math.cos(rad) * GHOST_LEN;
    const endY = d.originY + Math.sin(rad) * GHOST_LEN;
    strokeLine(d.originX, d.originY, endX, endY, pal.accent, 3, null);

    ctx.beginPath();
    ctx.arc(d.originX, d.originY, 6, 0, Math.PI * 2);
    ctx.fillStyle = pal.accent;
    ctx.fill();

    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.arc(d.mouseX, d.mouseY, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = pal.accent;
    ctx.fill();
    ctx.restore();

    return { x: endX, y: endY };
}

const badgeBase =
    'absolute -translate-x-1/2 -translate-y-full rounded-md px-2 py-1 font-mono text-[11px] font-semibold shadow-lg pointer-events-none';

function updateAngleBadge(ghostEnd) {
    if (!state.dragging || !ghostEnd) {
        el.angleBadge.classList.add('hidden');
        return;
    }
    const norm = Math.round(((state.dragging.angleDeg % 360) + 360) % 360);
    el.angleBadge.textContent = `${norm}°`;
    el.angleBadge.style.left = `${ghostEnd.x}px`;
    el.angleBadge.style.top = `${ghostEnd.y - 12}px`;
    el.angleBadge.className = state.dragging.snapped
        ? `${badgeBase} bg-sky-600 text-white dark:bg-sky-500 dark:text-slate-950`
        : `${badgeBase} border border-slate-300 bg-white/95 text-slate-900 dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-100`;
}

/* --------------------------------------------------------------- the pin */

function repositionPin() {
    if (!state.selectedId) return;
    const built = state.builtRoads.find((r) => r.id === state.selectedId);
    if (!built) return;
    el.pin.style.left = `${built.pinX}px`;
    el.pin.style.top = `${built.pinY}px`;
}

function showPin(roadId) {
    const raw = state.placedRoads.find((r) => r.id === roadId);
    if (!raw) {
        hidePin();
        return;
    }
    el.pin.dataset.roadId = roadId;
    el.pinType.textContent = raw.type === 'twoway' ? 'Two-way' : 'One-way';
    el.pinLanes.value = raw.lanes;
    el.pin.classList.remove('hidden');
    repositionPin();
}

function hidePin() {
    el.pin.classList.add('hidden');
    delete el.pin.dataset.roadId;
}

el.pinLanes.addEventListener('change', () => {
    const roadId = el.pin.dataset.roadId;
    if (!roadId) return;
    const n = Math.min(6, Math.max(1, parseInt(el.pinLanes.value, 10) || 1));
    state.placedRoads = state.placedRoads.map((r) => (r.id === roadId ? { ...r, lanes: n } : r));
    draw();
});

el.pinDone.addEventListener('click', () => {
    state.selectedId = null;
    hidePin();
    draw();
});

/* -------------------------------------------------------------- hit testing */

function hitTestPoint(x, y) {
    for (const road of state.builtRoads) {
        for (const pt of road.points) {
            if (Math.hypot(pt.x - x, pt.y - y) <= POINT_HIT_RADIUS) return pt;
        }
    }
    return null;
}

function hitTestRoad(x, y) {
    let best = null;
    let bestDist = Infinity;
    for (const road of state.builtRoads) {
        const dx = road.x2 - road.x1;
        const dy = road.y2 - road.y1;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - road.x1) * dx + (y - road.y1) * dy) / len2));
        const projX = road.x1 + t * dx;
        const projY = road.y1 + t * dy;
        const dist = Math.hypot(x - projX, y - projY);
        const tolerance = road.roadWidth / 2 + 3;
        if (dist <= tolerance && dist < bestDist) {
            bestDist = dist;
            best = road;
        }
    }
    return best;
}

/* ------------------------------------------------------------ interactions */

el.canvas.addEventListener('pointerdown', (event) => {
    const rect = el.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const point = hitTestPoint(x, y);
    if (point) {
        event.preventDefault();
        el.canvas.setPointerCapture(event.pointerId);
        state.dragging = { originX: point.x, originY: point.y, mouseX: point.x, mouseY: point.y, angleDeg: 0, snapped: false };
        hidePin();
        draw();
        return;
    }

    const road = hitTestRoad(x, y);
    state.selectedId = road ? road.id : null;
    draw();
    if (road) showPin(road.id);
    else hidePin();
});

el.canvas.addEventListener('pointermove', (event) => {
    if (!state.dragging) return;
    const rect = el.canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const d = state.dragging;
    const raw = (Math.atan2(my - d.originY, mx - d.originX) * 180) / Math.PI;
    const snapTo = Math.round(raw / SNAP_STEP) * SNAP_STEP;
    const snapped = Math.abs(raw - snapTo) < SNAP_TOLERANCE;
    state.dragging = { ...d, mouseX: mx, mouseY: my, angleDeg: snapped ? snapTo : raw, snapped };
    draw();
});

function commitDrag(event) {
    const d = state.dragging;
    if (!d) return;
    const rad = (d.angleDeg * Math.PI) / 180;
    const id = `road-${state.nextId}`;
    const newRoad = {
        id,
        x1: d.originX,
        y1: d.originY,
        x2: d.originX + Math.cos(rad) * GHOST_LEN,
        y2: d.originY + Math.sin(rad) * GHOST_LEN,
        type: state.roadType,
        lanes: state.lanes,
    };
    state.placedRoads = [...state.placedRoads, newRoad];
    state.dragging = null;
    state.selectedId = id;
    state.nextId += 1;
    if (el.canvas.hasPointerCapture(event.pointerId)) el.canvas.releasePointerCapture(event.pointerId);
    draw();
    showPin(id);
}

el.canvas.addEventListener('pointerup', commitDrag);
el.canvas.addEventListener('pointercancel', () => {
    state.dragging = null;
    draw();
});

/* --------------------------------------------------------- palette drag-drop */

el.paletteTile.addEventListener('dragstart', (event) => {
    try {
        event.dataTransfer.setData('text/plain', 'road');
        event.dataTransfer.effectAllowed = 'copy';
    } catch {
        // Some browsers refuse setData for certain types under odd security
        // contexts - the drag still works without it, just without a payload.
    }
});

el.canvasWrap.addEventListener('dragover', (event) => event.preventDefault());
el.canvasWrap.addEventListener('drop', (event) => {
    event.preventDefault();
    const rect = el.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const id = `road-${state.nextId}`;
    const newRoad = { id, x1: x - 110, y1: y, x2: x + 110, y2: y, type: state.roadType, lanes: state.lanes };
    state.placedRoads = [...state.placedRoads, newRoad];
    state.selectedId = id;
    state.nextId += 1;
    draw();
    showPin(id);
});

/* ------------------------------------------------------------ panel controls */

function updatePaletteMeta() {
    el.lanesValue.textContent = String(state.lanes);
    const typeLabel = state.roadType === 'twoway' ? 'Two-way' : 'One-way';
    el.paletteMeta.textContent = `${state.lanes} lanes · ${typeLabel}`;
}

el.lanesDec.addEventListener('click', () => {
    state.lanes = Math.max(1, state.lanes - 1);
    updatePaletteMeta();
});
el.lanesInc.addEventListener('click', () => {
    state.lanes = Math.min(6, state.lanes + 1);
    updatePaletteMeta();
});

// Same delegation idiom as simulator.js's segmented controls: identify by
// data-control, toggle data-active/aria-pressed on the sibling buttons.
document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-control="roadType"][data-value]');
    if (!button) return;
    const group = button.closest('[data-segmented]');
    group.querySelectorAll('button[data-value]').forEach((option) => {
        const active = option === button;
        option.dataset.active = active ? 'true' : 'false';
        option.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    state.roadType = button.dataset.value;
    updatePaletteMeta();
});

el.resetButton.addEventListener('click', () => {
    state.placedRoads = initialRoads();
    state.selectedId = null;
    state.dragging = null;
    state.nextId = 2;
    hidePin();
    draw();
});

/* --------------------------------------------------------------------- boot */

onThemeChange((theme) => {
    state.theme = theme;
    draw();
});

updatePaletteMeta();
new ResizeObserver(resizeCanvas).observe(el.canvasWrap);
resizeCanvas();
