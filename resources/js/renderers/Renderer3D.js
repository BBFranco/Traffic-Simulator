/**
 * Renderer3D.js - three.js view of the same simulation the 2D map draws.
 *
 * READ-ONLY by construction: it is handed `buildLayout()` output once and one
 * `engine.snapshot()` per frame, and holds no reference to the engine at all.
 * Frame rate only decides how often this paints - simulator.js's accumulator
 * alone decides how many ticks run.
 *
 * World mapping: sim (x east, y south, metres) -> three (x, 0, z). The sim's y
 * already points south, which is three's +z when looking down from +y, so the
 * scene is not mirrored relative to the 2D map.
 *
 * Draw-call budget (so 500+ vehicles stay at 60 fps): all static road geometry
 * is merged into one mesh per material, every vehicle shape is three
 * InstancedMeshes (body / trim / brake lamps), and every signal part is one
 * InstancedMesh for the whole corridor.
 *
 * Vehicle level of detail, picked per car per frame by how many pixels long it
 * is on screen (so it behaves the same on any viewport): the full model up
 * close, then each shape's simple two-tone model (one draw call, no separate
 * wheels) with brake lamps, then that simple model alone. Cars outside the
 * view frustum are not written at all, and only the used part of each
 * instance buffer is uploaded.
 */
import {
    AdditiveBlending,
    BoxGeometry,
    BufferAttribute,
    BufferGeometry,
    Color,
    CylinderGeometry,
    DirectionalLight,
    DoubleSide,
    DynamicDrawUsage,
    Frustum,
    HemisphereLight,
    InstancedBufferAttribute,
    InstancedMesh,
    Matrix4,
    Mesh,
    MeshBasicMaterial,
    MeshLambertMaterial,
    PerspectiveCamera,
    PlaneGeometry,
    Scene,
    Sphere,
    SphereGeometry,
    SRGBColorSpace,
    CanvasTexture,
    Vector3,
    WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { ARTERIAL_ACCENTS, LayoutRenderer, litLensIndexFor } from '../sim/renderer.js';
import { SnapshotBuffer } from './SnapshotBuffer.js';
import { laneArrowShapes } from './laneArrows.js';
import { turnLaneShapes, medianTurnLaneReachM } from './turnLaneShapes.js';
import { SHAPE_KEYS, buildVehicleGeometries, shapeFor } from './vehicleModels.js';

const PALETTES = {
    light: {
        background: '#dbe3ec',
        ground: '#d3dbcf',
        asphalt: '#5b6472',
        junction: '#666f7d',
        laneDash: '#f1f5f9',
        edgeLine: '#e2e8f0',
        centreLine: '#facc15',
        stopLine: '#ffffff',
        pole: '#475569',
        housing: '#1f2937',
        median: '#b8bfc7',
        trim: '#1e293b',
        lensOff: ['#4a1d22', '#4a3a14', '#163d2a'],
    },
    dark: {
        background: '#070b12',
        ground: '#121923',
        asphalt: '#2c3543',
        junction: '#353f4f',
        laneDash: '#cbd5e1',
        edgeLine: '#94a3b8',
        centreLine: '#c9a227',
        stopLine: '#e2e8f0',
        pole: '#64748b',
        housing: '#0b1220',
        median: '#4b5563',
        trim: '#0b1220',
        lensOff: ['#3a1519', '#3a2e0f', '#11301f'],
    },
};

/** Passenger-car body colours with their share of the fleet in percent (sums to 100) - see carColourFor(). */
const CAR_BODY_COLOURS = [
    { share: 28, hex: '#f1f5f9' }, // white
    { share: 24, hex: '#1a1d23' }, // black
    { share: 18, hex: '#6b7280' }, // grey
    { share: 10, hex: '#c3c8ce' }, // silver
    { share: 8, hex: '#1e4a9a' }, // blue
    { share: 6, hex: '#b91c1c' }, // red
    { share: 2, hex: '#2f5d3a' }, // green
    { share: 2, hex: '#cdbb94' }, // beige / sand
    { share: 1, hex: '#5c3d2e' }, // brown
    { share: 1, hex: '#c9a227' }, // yellow / gold
];
/** Minibus taxis are near-universally white in South Africa. */
const TAXI_BODY_COLOUR = '#f8fafc';
/** The random-events BMW - purple so it's easy to follow as it weaves. */
const BMW_BODY_COLOUR = '#7e22ce';
/** The random-events Ranger - orange, so the tailgater in the fast lane stands out. */
const RANGER_BODY_COLOUR = '#ea580c';
/** Most trucks are white; the coloured part is either the cab or the box/trailer. */
const TRUCK_WHITE = '#f1f5f9';
const TRUCK_ACCENT_COLOURS = ['#b91c1c', '#1e4a9a', '#2f5d3a', '#d97706', '#c9a227', '#374151', '#7f1d1d', '#0f766e'];
/** Share of trucks (out of 100) with a white box/trailer and a coloured cab - the rest have a white cab and a coloured load. */
const TRUCK_COLOURED_CAB_SHARE = 70;
const TRUCK_SHAPES = new Set(['truck_small', 'truck_medium', 'truck_large']);
/** Bus body colours - white is weighted up by repetition. A white bus gets a coloured livery stripe, a coloured one a white stripe. */
const BUS_BODY_COLOURS = ['#f1f5f9', '#f1f5f9', '#f1f5f9', '#15803d', '#1e4a9a', '#b91c1c', '#c9a227'];
const BUS_STRIPE_COLOURS = ['#15803d', '#1e4a9a', '#b91c1c', '#d97706', '#0f766e'];
/** Universal lit-lens hues (renderer.js's LIT_LENS_COLOURS). */
const LIT_LENS_COLOURS = ['#ef4444', '#f59e0b', '#22c55e'];

const CAMERA_PITCH_RAD = (55 * Math.PI) / 180;
const CAMERA_FOV_DEG = 45;
const INITIAL_VEHICLE_CAPACITY = 256;

/** Vehicle LOD levels; CULLED cars are outside the view and not drawn at all. */
const LOD = { FULL: 0, MID: 1, FAR: 2, CULLED: -1 };
/** On-screen length (CSS px) a car needs to be drawn at FULL, or at MID - anything shorter is a FAR box. */
const LOD_MIN_PX = [20, 6];
/** A car only drops to a coarser level once it is this much below that level's threshold, so it doesn't flicker on the boundary. */
const LOD_HYSTERESIS = 0.8;
/** Added to half a vehicle's length for its culling sphere - covers its height, so a tall truck at the view edge isn't dropped early. */
const CULL_RADIUS_PAD_M = 2.5;

/** Map symbols more than scale models: a true-size 0.3 m lens vanishes at corridor zoom, so heads are drawn larger. */
const SIGNAL_SCALE = 1.8;
const POLE_HEIGHT_M = 3.2 * SIGNAL_SCALE;
const HOUSING = { depth: 0.35 * SIGNAL_SCALE, height: 1.1 * SIGNAL_SCALE, width: 0.42 * SIGNAL_SCALE };
const LENS_RADIUS_M = 0.14 * SIGNAL_SCALE;
const LENS_GAP_M = 0.34 * SIGNAL_SCALE;

/** Light levels under normal power vs. during a load-shedding outage. */
const LIGHTING = { normal: { hemi: 1.15, sun: 1.5 }, outage: { hemi: 0.38, sun: 0.45 } };
/** Road layers are unlit (MeshBasicMaterial), so they are dimmed by colour instead of by the lights. */
const FLAT_KEYS = ['asphalt', 'junction', 'laneDash', 'edgeLine', 'centreLine', 'stopLine'];
const OUTAGE_FLAT_DIM = 0.5;

/** Draw order for the flat road layers - they skip the depth test, so this alone decides what paints over what. */
const LAYER_ORDER = { ground: 0, asphalt: 1, markings: 2, junction: 3, stopLines: 4 };

const toThree = (p, y = 0) => new Vector3(p.x, y, p.y);

/**
 * Two kinds of street name, crossfaded by zoom: floating pills (DOM, constant
 * screen size) read well from the overview but end up off-screen once you are
 * down at street level, so up close the names are painted on the road surface
 * itself, sized in metres like real road markings.
 */
const PILLS_FADE_M = [180, 320]; // camera distance: pills fully hidden below the first, fully shown above the second
const ROAD_NAMES_FADE_M = [650, 1000]; // road-surface names fully shown below the first, gone above the second
const ROAD_NAME_OPACITY = 0.8;
const ROAD_NAME_HEIGHT_M = { arterial: 3, cross: 2.4 };
const ROAD_NAME_SPACING_M = 70;
const MEDIAN_HEIGHT_M = 0.18;
/** Median islands stop this far outside the junction box. */
const MEDIAN_JUNCTION_CLEARANCE_M = 1.5;
/** Kept clear of each end of a stretch: junction box plus, on arterials, the lane-use arrows 8-50 m before the stop line. */
const ROAD_NAME_END_MARGIN_M = { arterial: 60, cross: 14 };
const LABEL_HEIGHT_M = 3;
const LABEL_CLASSES = {
    street: 'whitespace-nowrap rounded-md bg-white/85 px-1.5 py-0.5 text-[11px] text-slate-600 shadow-sm dark:bg-slate-900/80 dark:text-slate-300',
    node: 'flex items-center gap-1.5 whitespace-nowrap rounded-md bg-white/90 px-1.5 py-0.5 text-[11px] text-slate-800 shadow-sm dark:bg-slate-900/85 dark:text-slate-100',
    arterial: 'flex items-center gap-1.5 whitespace-nowrap rounded-md bg-white/90 px-2 py-0.5 text-xs font-semibold text-slate-800 shadow-sm dark:bg-slate-900/85 dark:text-slate-100',
};

/** @implements {import('./RendererInterface.js').SimRenderer} */
export class Renderer3D {
    /**
     * @param host     element the WebGL canvas is appended to (simulator.js's #canvas-wrap)
     * @param overlay  "All-way stop" element shown during outages
     * @param dtS      fixed tick length - the interpolation window
     */
    constructor(host, overlay, dtS) {
        this.host = host;
        this.overlay = overlay;
        this.dtS = dtS;
        this.theme = 'light';
        this.layout = null;
        this.buffer = new SnapshotBuffer();
        this.outage = null;

        // A fresh canvas per instance: once a context has been force-lost the
        // same element can never hand out a new one, so re-entering 3D needs its own.
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'absolute inset-0 block h-full w-full';
        this.canvas.dataset.view = '3d';
        host.prepend(this.canvas);

        this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

        // Label layer sits right above the canvas and below the page's own overlays; it never takes pointer input.
        this.labelRenderer = new CSS2DRenderer();
        this.labelRenderer.domElement.className = 'pointer-events-none absolute inset-0';
        this.canvas.after(this.labelRenderer.domElement);

        this.scene = new Scene();
        this.camera = new PerspectiveCamera(CAMERA_FOV_DEG, 1, 1, 10000);
        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.12;
        this.controls.screenSpacePanning = false;
        this.controls.maxPolarAngle = (84 * Math.PI) / 180;
        this.controls.minDistance = 8;

        this.hemi = new HemisphereLight('#ffffff', '#5b6472', LIGHTING.normal.hemi);
        this.sun = new DirectionalLight('#ffffff', LIGHTING.normal.sun);
        this.sun.position.set(-0.45, 1, 0.3);
        this.scene.add(this.hemi, this.sun);

        this.materials = this.createMaterials();
        this.vehicleGeometries = buildVehicleGeometries();
        this.vehicleMeshes = {};
        for (const key of SHAPE_KEYS) this.vehicleMeshes[key] = this.createVehicleMeshes(key, INITIAL_VEHICLE_CAPACITY);
        this.lodById = new Map();
        this.nextLodById = new Map();
        this.carLods = new Int8Array(INITIAL_VEHICLE_CAPACITY);
        this.frustum = new Frustum();
        this.viewProjection = new Matrix4();
        this.cullSphere = new Sphere();
        this.pxPerMetre = 1;
        this.pillsVisible = true;

        this.staticMeshes = [];
        this.signalMeshes = [];
        this.labels = [];
        this.roadNameMeshes = [];
        this.stopLineMesh = null;
        this.stopLineKey = null;
        this.approaches = [];
        this.labelFade = null;
        this.colour = new Color();
        this.accentColour = new Color();

        this.applyTheme();
        this.resize();
    }

    /* -------------------------------------------------------------- contract */

    init(layout) {
        this.layout = layout;
        this.buffer.clear();
        this.clearLayoutMeshes();
        this.buildRoads();
        this.buildSignals();
        this.buildLabels();
        this.buildRoadNames();
        this.labelFade = null;
        this.fit();
    }

    update(snapshot, alpha) {
        if (!this.layout) return;
        this.buffer.push(snapshot);

        this.applyPower(snapshot.powerState === 'load_shedding');
        this.updateStopLines(snapshot.signals);
        this.updateSignals(snapshot.signals);

        // Camera first: vehicle culling and LOD read this frame's view.
        this.controls.update();
        this.updateClipPlanes();
        this.camera.updateMatrixWorld();
        this.updateVehicles(this.buffer.interpolatedCars(alpha, this.dtS));

        this.updateLabelFade();
        this.updateRoadNameFacing();
        this.renderer.render(this.scene, this.camera);
        // Pills are fully faded out up close - skip repositioning their DOM nodes then.
        if (this.pillsVisible) this.labelRenderer.render(this.scene, this.camera);
    }

    resize() {
        const width = Math.max(1, this.host.clientWidth);
        const height = Math.max(1, this.host.clientHeight);
        this.renderer.setSize(width, height, false);
        this.labelRenderer.setSize(width, height);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        // Screen pixels one metre spans at one metre from the camera; divide by distance for any other depth.
        this.pxPerMetre = height / (2 * Math.tan((CAMERA_FOV_DEG * Math.PI) / 360));
    }

    setTheme(theme) {
        this.theme = PALETTES[theme] ? theme : 'light';
        this.applyTheme();
    }

    fit() {
        if (!this.layout) return;
        const b = this.layout.bounds;
        const target = new Vector3((b.minX + b.maxX) / 2, 0, (b.minY + b.maxY) / 2);
        const halfFov = (CAMERA_FOV_DEG * Math.PI) / 360;
        const fitH = b.heightM / Math.max(Math.sin(CAMERA_PITCH_RAD), 0.1);
        const fitW = b.widthM / Math.max(this.camera.aspect, 0.1);
        const distance = ((Math.max(fitH, fitW) / 2) / Math.tan(halfFov)) * 1.25;

        this.controls.target.copy(target);
        this.camera.position.set(
            target.x,
            distance * Math.sin(CAMERA_PITCH_RAD),
            target.z + distance * Math.cos(CAMERA_PITCH_RAD)
        );
        this.controls.maxDistance = distance * 3;
        this.controls.update();
    }

    dispose() {
        this.controls.dispose();
        this.scene.traverse((object) => {
            if (object.isInstancedMesh) object.dispose();
            object.geometry?.dispose();
            if (object.material) {
                for (const material of [].concat(object.material)) {
                    material.map?.dispose();
                    material.dispose();
                }
            }
        });
        for (const geometries of Object.values(this.vehicleGeometries)) {
            for (const geometry of Object.values(geometries)) geometry?.dispose(); // `accent` is null for shapes without a two-tone cab
        }
        this.renderer.dispose();
        this.renderer.forceContextLoss();
        this.canvas.remove();
        this.labelRenderer.domElement.remove();
        this.overlay?.classList.add('hidden');
        this.buffer.clear();
        this.layout = null;
    }

    /* ------------------------------------------------------------- materials */

    createMaterials() {
        const flat = (order) => {
            const material = new MeshBasicMaterial({ side: DoubleSide, depthTest: false, depthWrite: false });
            material.userData.order = order;
            return material;
        };
        return {
            ground: new MeshLambertMaterial(),
            asphalt: flat(LAYER_ORDER.asphalt),
            junction: flat(LAYER_ORDER.junction),
            laneDash: flat(LAYER_ORDER.markings),
            edgeLine: flat(LAYER_ORDER.markings),
            centreLine: flat(LAYER_ORDER.markings),
            stopLine: flat(LAYER_ORDER.stopLines),
            vehicleBody: new MeshLambertMaterial(),
            vehicleTrim: new MeshLambertMaterial(),
            vehicleSimple: createSimpleVehicleMaterial(),
            brake: new MeshBasicMaterial({ color: '#ff2a2a' }),
            pole: new MeshLambertMaterial(),
            housing: new MeshLambertMaterial(),
            median: new MeshLambertMaterial({ side: DoubleSide }),
            lens: new MeshBasicMaterial(),
            halo: new MeshBasicMaterial({ transparent: true, opacity: 0.32, blending: AdditiveBlending, depthWrite: false }),
        };
    }

    applyTheme() {
        const p = PALETTES[this.theme];
        const m = this.materials;
        for (const key of ['ground', 'pole', 'housing', 'median']) m[key].color.set(p[key]);
        m.vehicleTrim.color.set(p.trim);
        m.vehicleSimple.userData.trimColour.value.set(p.trim);
        this.applyFlatColours();
        this.hemi.groundColor.set(p.asphalt);
        this.lensOffColours = p.lensOff.map((hex) => new Color(hex));
        this.lensOnColours = LIT_LENS_COLOURS.map((hex) => new Color(hex));
        this.signalState = null; // force a lens repaint in the new palette
        this.applyBackground();
    }

    applyFlatColours() {
        const p = PALETTES[this.theme];
        for (const key of FLAT_KEYS) {
            this.materials[key].color.set(p[key]);
            if (this.outage) this.materials[key].color.multiplyScalar(OUTAGE_FLAT_DIM);
        }
        for (const mesh of this.roadNameMeshes) mesh.material.color.setScalar(this.outage ? OUTAGE_FLAT_DIM : 1);
    }

    applyBackground() {
        const background = new Color(PALETTES[this.theme].background);
        if (this.outage) background.multiplyScalar(0.35);
        this.scene.background = background;
    }

    applyPower(outage) {
        if (outage === this.outage) return;
        this.outage = outage;
        const level = outage ? LIGHTING.outage : LIGHTING.normal;
        this.hemi.intensity = level.hemi;
        this.sun.intensity = level.sun;
        this.applyFlatColours();
        this.applyBackground();
        this.overlay?.classList.toggle('hidden', !outage);
    }

    /* ----------------------------------------------------------------- roads */

    clearLayoutMeshes() {
        for (const mesh of [...this.staticMeshes, ...this.signalMeshes, this.stopLineMesh].filter(Boolean)) {
            this.scene.remove(mesh);
            if (mesh.isInstancedMesh) mesh.dispose();
            mesh.geometry.dispose();
        }
        for (const label of this.labels) this.scene.remove(label); // CSS2DObject drops its DOM node on 'removed'
        for (const mesh of this.roadNameMeshes) {
            this.scene.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.map.dispose();
            mesh.material.dispose();
        }
        this.roadNameMeshes = [];
        this.staticMeshes = [];
        this.signalMeshes = [];
        this.labels = [];
        this.stopLineMesh = null;
        this.stopLineKey = null;
        this.approaches = [];
        this.signalState = null;
    }

    /* ---------------------------------------------------------------- labels */

    /** Turn each road-surface name 180 degrees whenever it would otherwise read upside down from where the camera now is. */
    updateRoadNameFacing() {
        const m = this.camera.matrixWorld.elements;
        const right = { x: m[0], y: m[2] }; // camera's screen-right, on the ground plane (three z = sim y)
        for (const mesh of this.roadNameMeshes) {
            const { readDir } = mesh.userData;
            const flipped = readDir.x * right.x + readDir.y * right.y < 0;
            if (flipped === mesh.userData.flipped) continue;
            mesh.userData.flipped = flipped;
            mesh.rotation.y += Math.PI;
        }
    }

    /** Crossfade pills vs. road-surface names by how far the camera is from what it's looking at. */
    updateLabelFade() {
        const distance = this.camera.position.distanceTo(this.controls.target);
        const pills = smoothstep(PILLS_FADE_M[0], PILLS_FADE_M[1], distance);
        const roadNames = 1 - smoothstep(ROAD_NAMES_FADE_M[0], ROAD_NAMES_FADE_M[1], distance);
        const key = `${pills.toFixed(2)}|${roadNames.toFixed(2)}`;
        if (key === this.labelFade) return;
        this.labelFade = key;

        this.labelRenderer.domElement.style.opacity = String(pills);
        this.labelRenderer.domElement.style.visibility = pills > 0 ? 'visible' : 'hidden';
        this.pillsVisible = pills > 0;
        for (const mesh of this.roadNameMeshes) {
            mesh.material.opacity = roadNames * ROAD_NAME_OPACITY;
            mesh.visible = roadNames > 0;
        }
    }

    /**
     * Street names painted flat on the carriageway, repeated every
     * ROAD_NAME_SPACING_M along each stretch of road (approach, each block,
     * run-out; each cross-street span and stub), kept clear of the junctions
     * and of the lane-use arrows before each stop line, and centred in a lane
     * rather than on a divider line. Text always reads left-to-right or
     * bottom-to-top from the default camera, never upside down.
     */
    buildRoadNames() {
        const stretches = [];
        const nodePoint = (id) => this.layout.nodesById.get(id).point;
        const add = (text, from, to, kind, lanes, laneWidthM, medianWidthM = 0) =>
            stretches.push({ text, from, to, kind, lanes, laneWidthM, medianWidthM });

        for (const arterial of this.layout.arterials) {
            const points = [arterial.startPoint, ...arterial.intersections.map((n) => n.point), arterial.endPoint];
            for (let i = 0; i < points.length - 1; i += 1) {
                add(arterial.shortName, points[i], points[i + 1], 'arterial', arterial.lanes, arterial.laneWidthM, arterial.medianWidthM);
            }
            for (const node of arterial.intersections) {
                if (!node.crossStub) continue;
                const laneWidthM = node.crossRoadWidthM / node.crossLanes;
                add(node.crossStreetName, node.crossStub.startPoint, node.point, 'cross', node.crossLanes, laneWidthM);
                add(node.crossStreetName, node.point, node.crossStub.endPoint, 'cross', node.crossLanes, laneWidthM);
            }
        }
        for (const connector of this.layout.connectors) {
            const points = [connector.startPoint, ...connector.nodeIds.map(nodePoint), connector.endPoint];
            for (let i = 0; i < points.length - 1; i += 1) {
                add(connector.name, points[i], points[i + 1], 'cross', connector.lanes, connector.laneWidthM, connector.medianWidthM);
            }
        }

        const textures = new Map();
        for (const { text, from, to, kind, lanes, laneWidthM, medianWidthM } of stretches) {
            if (!text) continue;
            if (!textures.has(text)) textures.set(text, this.createTextTexture(text));
            const { texture, aspect } = textures.get(text);

            const lengthM = Math.hypot(to.x - from.x, to.y - from.y);
            const heightM = ROAD_NAME_HEIGHT_M[kind];
            const widthM = heightM * aspect;
            const usableM = lengthM - 2 * ROAD_NAME_END_MARGIN_M[kind];
            if (usableM < widthM) continue;

            let dir = { x: (to.x - from.x) / lengthM, y: (to.y - from.y) / lengthM };
            // Mostly east-west roads read west to east; mostly north-south roads read south to north.
            const flip = Math.abs(dir.x) >= Math.abs(dir.y) ? dir.x < 0 : dir.y > 0;
            if (flip) dir = { x: -dir.x, y: -dir.y };
            // An even lane count puts a divider (or median) on the centreline - shift into the first lane beside it.
            const sideM = lanes % 2 === 0 ? medianWidthM / 2 + laneWidthM / 2 : 0;
            const up = { x: dir.y, y: -dir.x };

            const count = Math.floor((usableM - widthM) / ROAD_NAME_SPACING_M) + 1;
            const centre = { x: (from.x + to.x) / 2 + up.x * sideM, y: (from.y + to.y) / 2 + up.y * sideM };
            for (let i = 0; i < count; i += 1) {
                const alongM = (i - (count - 1) / 2) * ROAD_NAME_SPACING_M;
                const geometry = new PlaneGeometry(widthM, heightM);
                geometry.rotateX(-Math.PI / 2);
                const material = new MeshBasicMaterial({
                    map: texture,
                    transparent: true,
                    opacity: ROAD_NAME_OPACITY,
                    depthTest: false,
                    depthWrite: false,
                });
                const mesh = new Mesh(geometry, material);
                mesh.position.set(centre.x + dir.x * alongM, 0, centre.y + dir.y * alongM);
                mesh.rotation.y = Math.atan2(-dir.y, dir.x);
                mesh.userData.readDir = dir;
                mesh.userData.flipped = false;
                mesh.renderOrder = LAYER_ORDER.markings;
                mesh.frustumCulled = false;
                this.scene.add(mesh);
                this.roadNameMeshes.push(mesh);
            }
        }
        this.applyFlatColours();
    }

    createTextTexture(text) {
        const fontPx = 96;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const font = `700 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
        ctx.font = font;
        canvas.width = Math.ceil(ctx.measureText(text).width + fontPx * 0.5);
        canvas.height = Math.ceil(fontPx * 1.3);
        ctx.font = font; // resizing the canvas resets its context state
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);

        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;
        texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        return { texture, aspect: canvas.width / canvas.height };
    }

    addLabel(text, point, kind, accent = null) {
        if (!text) return;
        const element = document.createElement('div');
        element.className = LABEL_CLASSES[kind];
        if (accent) {
            const dot = document.createElement('span');
            dot.className = 'h-2 w-2 shrink-0 rounded-full';
            dot.style.backgroundColor = accent;
            element.append(dot);
        }
        element.append(document.createTextNode(text));

        const label = new CSS2DObject(element);
        label.position.copy(toThree(point, LABEL_HEIGHT_M));
        this.scene.add(label);
        this.labels.push(label);
    }

    /** Same anchors as renderer.js's drawLabels(): cross-street names at their north end, intersection and arterial names on the outward side. */
    buildLabels() {
        const northEnd = (a, b) => (a.y <= b.y ? a : b);
        for (const connector of this.layout.connectors) {
            this.addLabel(connector.name, northEnd(connector.startPoint, connector.endPoint), 'street');
        }

        const outwardSide = (arterial) => LayoutRenderer.prototype.outwardSide.call({ layout: this.layout }, arterial);
        this.layout.arterials.forEach((arterial, ai) => {
            const accent = ARTERIAL_ACCENTS[ai % ARTERIAL_ACCENTS.length];
            const side = outwardSide(arterial);

            for (const node of arterial.intersections) {
                if (node.crossStub) {
                    this.addLabel(node.crossStreetName, northEnd(node.crossStub.startPoint, node.crossStub.endPoint), 'street');
                }
                const normal = { x: -node.arterialHeading.y, y: node.arterialHeading.x };
                const offM = arterial.roadWidthM / 2 + 26;
                this.addLabel(
                    node.name,
                    { x: node.point.x + normal.x * offM * side, y: node.point.y + normal.y * offM * side },
                    'node',
                    accent
                );
            }

            // Mid-corridor rather than at the entry (where the 2D map puts it), so the banner never hangs off the view edge.
            const [a, b] = [arterial.intersections[0], arterial.intersections[arterial.intersections.length - 1]];
            const mid = { x: (a.point.x + b.point.x) / 2, y: (a.point.y + b.point.y) / 2 };
            const midNormal = { x: -arterial.heading.y, y: arterial.heading.x };
            const bannerOffM = arterial.roadWidthM / 2 + 110;
            this.addLabel(
                arterial.name,
                { x: mid.x + midNormal.x * bannerOffM * side, y: mid.y + midNormal.y * bannerOffM * side },
                'arterial',
                accent
            );
        });
    }

    addStatic(geometry, material, renderOrder) {
        if (!geometry) return;
        const mesh = new Mesh(geometry, material);
        mesh.renderOrder = renderOrder;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        this.staticMeshes.push(mesh);
    }

    buildRoads() {
        const b = this.layout.bounds;
        const span = Math.max(b.widthM, b.heightM);
        const ground = new PlaneGeometry(span * 4, span * 4);
        ground.rotateX(-Math.PI / 2);
        ground.translate((b.minX + b.maxX) / 2, -0.05, (b.minY + b.maxY) / 2);
        this.addStatic(ground, this.materials.ground, LAYER_ORDER.ground);

        const asphalt = new FlatLayer();
        const laneDash = new FlatLayer();
        const edgeLine = new FlatLayer();
        const centreLine = new FlatLayer();
        const junction = new FlatLayer();

        // Same road list (arterials, connectors, cross stubs) the 2D map strokes.
        LayoutRenderer.prototype.eachRoad.call({ layout: this.layout }, ({ from, to, widthM, lanes, laneWidthM, medianWidthM, twoWay, curvePoints }) => {
            const points = curvePoints ?? [from, to];
            const half = widthM / 2;
            const halfMedian = medianWidthM / 2;

            asphalt.ribbon(points, -half, half);
            for (const off of [-half + 0.25, half - 0.25]) edgeLine.line(points, off, 0.14);

            if (twoWay) {
                // A divided street gets a raised island (buildMedians()) instead of a painted centreline.
                if (medianWidthM === 0) centreLine.line(points, 0, 0.2);
                for (let i = 1; i < lanes / 2; i += 1) {
                    laneDash.dashed(points, halfMedian + i * laneWidthM, 0.13, 3, 6);
                    laneDash.dashed(points, -halfMedian - i * laneWidthM, 0.13, 3, 6);
                }
            } else {
                for (let i = 1; i < lanes; i += 1) laneDash.dashed(points, -half + i * laneWidthM, 0.13, 3, 6);
            }
        });

        const turnLanes = turnLaneShapes(this.layout);
        for (const [a, b, c, d] of turnLanes.surfaces) asphalt.quad(a, b, c, d);
        for (const segment of turnLanes.edges) edgeLine.line(segment, 0, 0.14);

        // Same two-rectangle union drawJunctions() uses, so skewed connectors are covered.
        for (const arterial of this.layout.arterials) {
            for (const node of arterial.intersections) {
                junction.rect(node.point, node.arterialHeading, node.crossRoadWidthM, node.arterialRoadWidthM);
                junction.rect(node.point, node.crossAxis, node.arterialRoadWidthM, node.crossRoadWidthM);
            }
        }

        const arrows = new FlatLayer();
        const { lines, heads } = laneArrowShapes(this.layout);
        for (const segment of lines) arrows.line(segment, 0, 0.28);
        for (const [a, b, c] of heads) arrows.triangle(a, b, c);

        const m = this.materials;
        this.addStatic(arrows.build(), m.laneDash, LAYER_ORDER.markings);
        this.addStatic(asphalt.build(), m.asphalt, LAYER_ORDER.asphalt);
        this.addStatic(edgeLine.build(), m.edgeLine, LAYER_ORDER.markings);
        this.addStatic(laneDash.build(), m.laneDash, LAYER_ORDER.markings);
        this.addStatic(centreLine.build(), m.centreLine, LAYER_ORDER.markings);
        this.addStatic(junction.build(), m.junction, LAYER_ORDER.junction);
        this.buildMedians();
    }

    /**
     * Raised median islands (kerb height) on divided streets, stopped
     * short of each junction box so turning traffic never drives through one -
     * and short of any median-side turn lane, which takes the island's place.
     */
    buildMedians() {
        const positions = [];
        const dividedStreets = [
            ...this.layout.connectors
                .filter((connector) => connector.medianWidthM && !connector.curve)
                .map((connector) => ({ road: connector, kind: 'cross', nodes: connector.nodeIds.map((id) => this.layout.nodesById.get(id)), depthOf: (node) => node.arterialRoadWidthM })),
            ...this.layout.arterials
                .filter((arterial) => arterial.medianWidthM)
                .map((arterial) => ({ road: arterial, kind: 'arterial', nodes: arterial.intersections, depthOf: (node) => node.crossRoadWidthM })),
        ];
        for (const { road, kind, nodes, depthOf } of dividedStreets) {
            // How far back from `node` the island stops for traffic arriving there heading `travel`.
            const clear = (node, travel) => {
                const approach = node.approaches.find((ap) => ap.kind === kind && ap.heading.x * travel.x + ap.heading.y * travel.y > 0.5);
                return Math.max(depthOf(node) / 2 + MEDIAN_JUNCTION_CLEARANCE_M, medianTurnLaneReachM(approach));
            };
            const stops = [[road.startPoint, null], ...nodes.map((node) => [node.point, node]), [road.endPoint, null]];
            const pieces = stops.slice(0, -1).map(([from, fromNode], i) => [from, fromNode, ...stops[i + 1]]);
            for (const [from, fromNode, to, toNode] of pieces) {
                const lengthM = Math.hypot(to.x - from.x, to.y - from.y);
                if (lengthM < 1) continue;
                const dir = { x: (to.x - from.x) / lengthM, y: (to.y - from.y) / lengthM };
                const trimFrom = fromNode ? clear(fromNode, { x: -dir.x, y: -dir.y }) : 0;
                const trimTo = toNode ? clear(toNode, dir) : 0;
                if (lengthM <= trimFrom + trimTo + 1) continue;
                const start = { x: from.x + dir.x * trimFrom, y: from.y + dir.y * trimFrom };
                const end = { x: to.x - dir.x * trimTo, y: to.y - dir.y * trimTo };
                pushKerbBlock(positions, start, end, road.medianWidthM / 2, MEDIAN_HEIGHT_M);
            }
        }
        if (!positions.length) return;
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
        geometry.computeVertexNormals();
        const mesh = new Mesh(geometry, this.materials.median);
        mesh.renderOrder = 10;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        this.staticMeshes.push(mesh);
    }

    /** Stop lines skip free-flow nodes (as the 2D map does), which is only known from the signal state - rebuilt only when that set changes. */
    updateStopLines(signals) {
        const freeFlowIds = [];
        for (const [nodeId, signal] of signals) if (signal.freeFlow) freeFlowIds.push(nodeId);
        const key = freeFlowIds.sort().join('|');
        if (key === this.stopLineKey) return;
        this.stopLineKey = key;

        if (this.stopLineMesh) {
            this.scene.remove(this.stopLineMesh);
            this.stopLineMesh.geometry.dispose();
            this.stopLineMesh = null;
        }

        const layer = new FlatLayer();
        const skip = new Set(freeFlowIds);
        for (const arterial of this.layout.arterials) {
            for (const node of arterial.intersections) {
                if (skip.has(node.id)) continue;
                for (const approach of node.approaches) layer.line([approach.stopLine.a, approach.stopLine.b], 0, 0.45);
            }
        }
        const geometry = layer.build();
        if (!geometry) return;
        this.stopLineMesh = new Mesh(geometry, this.materials.stopLine);
        this.stopLineMesh.renderOrder = LAYER_ORDER.stopLines;
        this.stopLineMesh.frustumCulled = false;
        this.scene.add(this.stopLineMesh);
    }

    /* --------------------------------------------------------------- signals */

    buildSignals() {
        for (const arterial of this.layout.arterials) {
            for (const node of arterial.intersections) {
                for (const approach of node.approaches) this.approaches.push({ nodeId: node.id, approach });
            }
        }
        const n = this.approaches.length;
        if (!n) return;

        const pole = new CylinderGeometry(0.07 * SIGNAL_SCALE, 0.09 * SIGNAL_SCALE, POLE_HEIGHT_M, 8);
        pole.translate(0, POLE_HEIGHT_M / 2, 0);
        const housing = new BoxGeometry(HOUSING.depth, HOUSING.height, HOUSING.width);
        housing.translate(0, POLE_HEIGHT_M + HOUSING.height / 2 - 0.1, 0);

        const m = this.materials;
        this.poles = this.addSignalMesh(pole, m.pole, n);
        this.housings = this.addSignalMesh(housing, m.housing, n);
        this.lenses = this.addSignalMesh(new SphereGeometry(LENS_RADIUS_M, 12, 8), m.lens, n * 3);
        this.halos = this.addSignalMesh(new SphereGeometry(LENS_RADIUS_M * 2.6, 12, 8), m.halo, n);
        this.lenses.instanceColor = new InstancedBufferAttribute(new Float32Array(n * 9), 3);
        this.halos.instanceColor = new InstancedBufferAttribute(new Float32Array(n * 3), 3);

        const matrix = new Matrix4();
        this.approaches.forEach((entry, k) => {
            const { signalHead, heading } = entry.approach;
            // Lenses face oncoming traffic, i.e. against the approach's direction of travel.
            const face = { x: -heading.x, y: -heading.y };
            const yaw = Math.atan2(-face.y, face.x);
            matrix.makeRotationY(yaw).setPosition(signalHead.x, 0, signalHead.y);
            entry.base = matrix.clone();
            entry.lensPoints = [0, 1, 2].map((i) =>
                toThree(
                    { x: signalHead.x + face.x * (HOUSING.depth / 2), y: signalHead.y + face.y * (HOUSING.depth / 2) },
                    POLE_HEIGHT_M + HOUSING.height / 2 - 0.1 + LENS_GAP_M - i * LENS_GAP_M
                )
            );
            entry.freeFlow = null;
            this.poles.setMatrixAt(k, matrix);
            this.housings.setMatrixAt(k, matrix);
            for (let i = 0; i < 3; i += 1) {
                this.lenses.setMatrixAt(k * 3 + i, new Matrix4().setPosition(entry.lensPoints[i]));
            }
        });
    }

    addSignalMesh(geometry, material, count) {
        const mesh = new InstancedMesh(geometry, material, count);
        mesh.frustumCulled = false;
        mesh.renderOrder = 10;
        this.scene.add(mesh);
        this.signalMeshes.push(mesh);
        return mesh;
    }

    /** Lens colours only change when a phase does, so repaint per approach on change instead of every frame. */
    updateSignals(signals) {
        if (!this.approaches.length) return;
        if (!this.signalState) this.signalState = new Int8Array(this.approaches.length).fill(-2);

        const zero = new Matrix4().makeScale(0, 0, 0);
        const haloMatrix = new Matrix4();
        let lensesDirty = false;
        let framesDirty = false;

        this.approaches.forEach((entry, k) => {
            const signal = signals.get(entry.nodeId) ?? null;
            const freeFlow = Boolean(signal?.freeFlow);

            if (freeFlow !== entry.freeFlow) {
                // A free-flow merge has no signal at all - hide the whole head rather than show a dark one.
                entry.freeFlow = freeFlow;
                this.poles.setMatrixAt(k, freeFlow ? zero : entry.base);
                this.housings.setMatrixAt(k, freeFlow ? zero : entry.base);
                for (let i = 0; i < 3; i += 1) {
                    this.lenses.setMatrixAt(k * 3 + i, freeFlow ? zero : new Matrix4().setPosition(entry.lensPoints[i]));
                }
                framesDirty = true;
                this.signalState[k] = -2;
            }

            // litLensIndexFor: 0 red, 1 amber, 2 green, -1 dark - the same order as the lenses top to bottom.
            const lit = freeFlow ? -1 : litLensIndexFor(entry.approach, signal);
            if (lit === this.signalState[k]) return;
            this.signalState[k] = lit;
            lensesDirty = true;

            for (let i = 0; i < 3; i += 1) {
                const colour = i === lit ? this.lensOnColours[i] : this.lensOffColours[i];
                this.lenses.instanceColor.setXYZ(k * 3 + i, colour.r, colour.g, colour.b);
            }
            if (lit >= 0) {
                haloMatrix.makeTranslation(entry.lensPoints[lit]);
                this.halos.setMatrixAt(k, haloMatrix);
                const colour = this.lensOnColours[lit];
                this.halos.instanceColor.setXYZ(k, colour.r, colour.g, colour.b);
            } else {
                this.halos.setMatrixAt(k, zero);
            }
        });

        if (framesDirty) {
            this.poles.instanceMatrix.needsUpdate = true;
            this.housings.instanceMatrix.needsUpdate = true;
        }
        if (lensesDirty || framesDirty) {
            this.lenses.instanceMatrix.needsUpdate = true;
            this.lenses.instanceColor.needsUpdate = true;
            this.halos.instanceMatrix.needsUpdate = true;
            this.halos.instanceColor.needsUpdate = true;
        }
    }

    /* -------------------------------------------------------------- vehicles */

    makeVehicleMesh(geometry, material, capacity, withColour = false) {
        const mesh = new InstancedMesh(geometry, material, capacity);
        mesh.count = 0;
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.renderOrder = 10;
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        if (withColour) {
            mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
            mesh.instanceColor.setUsage(DynamicDrawUsage);
        }
        this.scene.add(mesh);
        return mesh;
    }

    createVehicleMeshes(shape, capacity) {
        const g = this.vehicleGeometries[shape];
        return {
            capacity,
            body: this.makeVehicleMesh(g.body, this.materials.vehicleBody, capacity, true),
            accent: g.accent ? this.makeVehicleMesh(g.accent, this.materials.vehicleBody, capacity, true) : null,
            trim: this.makeVehicleMesh(g.trim, this.materials.vehicleTrim, capacity),
            brake: this.makeVehicleMesh(g.brake, this.materials.brake, capacity),
            simple: this.makeVehicleMesh(g.simple, this.materials.vehicleSimple, capacity, true),
        };
    }

    /** Swap a shape's meshes for ones with twice the room - the geometry is shared and kept. */
    growVehicleMeshes(shape) {
        const old = this.vehicleMeshes[shape];
        for (const mesh of [old.body, old.accent, old.trim, old.brake, old.simple]) {
            if (!mesh) continue;
            this.scene.remove(mesh);
            mesh.dispose();
        }
        this.vehicleMeshes[shape] = this.createVehicleMeshes(shape, old.capacity * 2);
    }

    /**
     * LOD for one car from its on-screen length. Moving to a finer level is
     * immediate; dropping to a coarser one waits until the car is clearly past
     * the threshold (LOD_HYSTERESIS), so it doesn't flicker between the two.
     */
    lodFor(sizePx, previous) {
        const target = sizePx >= LOD_MIN_PX[0] ? LOD.FULL : sizePx >= LOD_MIN_PX[1] ? LOD.MID : LOD.FAR;
        if (previous === undefined || target <= previous) return target;
        let lod = previous;
        while (lod < LOD.FAR && sizePx < LOD_MIN_PX[lod] * LOD_HYSTERESIS) lod += 1;
        return lod;
    }

    /**
     * Culls and picks a LOD for every car (into this.carLods), then fills only
     * the meshes each level uses: FULL is body + trim, MID and FAR the shape's
     * simple two-tone model, and brake lamps are drawn at FULL and MID.
     */
    updateVehicles(cars) {
        if (this.carLods.length < cars.length) this.carLods = new Int8Array(cars.length * 2);
        this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
        this.frustum.setFromProjectionMatrix(this.viewProjection);
        const eye = this.camera.position;

        const counts = {};
        const simpleCounts = {};
        const brakeCounts = {};
        for (const key of SHAPE_KEYS) {
            counts[key] = 0;
            simpleCounts[key] = 0;
            brakeCounts[key] = 0;
        }

        const next = this.nextLodById;
        next.clear();
        for (let i = 0; i < cars.length; i += 1) {
            const car = cars[i];
            const lengthM = car.lengthM ?? 4.5;
            this.cullSphere.center.set(car.x, 1, car.y);
            this.cullSphere.radius = lengthM / 2 + CULL_RADIUS_PAD_M;
            if (!this.frustum.intersectsSphere(this.cullSphere)) {
                this.carLods[i] = LOD.CULLED;
                continue;
            }
            const distance = Math.max(Math.hypot(car.x - eye.x, eye.y, car.y - eye.z), 0.1);
            const lod = this.lodFor((lengthM * this.pxPerMetre) / distance, this.lodById.get(car.id));
            this.carLods[i] = lod;
            next.set(car.id, lod);
            counts[shapeFor(car.vehicleType, car.id)] += 1;
        }
        // Swap maps so ids of cars that left (or went off-screen) drop out without a per-frame allocation.
        this.nextLodById = this.lodById;
        this.lodById = next;

        for (const key of SHAPE_KEYS) {
            while (counts[key] > this.vehicleMeshes[key].capacity) this.growVehicleMeshes(key);
            counts[key] = 0;
        }

        for (let i = 0; i < cars.length; i += 1) {
            const lod = this.carLods[i];
            if (lod === LOD.CULLED) continue;
            const car = cars[i];
            const shape = shapeFor(car.vehicleType, car.id);
            const meshes = this.vehicleMeshes[shape];
            this.colour.set(bodyColourFor(shape, car));

            if (lod === LOD.FULL) {
                const index = counts[shape]++;
                writeVehicleMatrix(meshes.body.instanceMatrix.array, index, car);
                writeColour(meshes.body.instanceColor.array, index, this.colour);
                writeVehicleMatrix(meshes.trim.instanceMatrix.array, index, car);
                if (meshes.accent) {
                    this.accentColour.set(accentColourFor(shape, car));
                    writeVehicleMatrix(meshes.accent.instanceMatrix.array, index, car);
                    writeColour(meshes.accent.instanceColor.array, index, this.accentColour);
                }
            } else {
                const index = simpleCounts[shape]++;
                writeVehicleMatrix(meshes.simple.instanceMatrix.array, index, car);
                writeColour(meshes.simple.instanceColor.array, index, this.colour);
            }
            if (car.stopped && lod !== LOD.FAR) writeVehicleMatrix(meshes.brake.instanceMatrix.array, brakeCounts[shape]++, car);
        }

        for (const key of SHAPE_KEYS) {
            const { body, accent, trim, brake, simple } = this.vehicleMeshes[key];
            commitInstances(body, counts[key]);
            if (accent) commitInstances(accent, counts[key]);
            commitInstances(trim, counts[key]);
            commitInstances(simple, simpleCounts[key]);
            commitInstances(brake, brakeCounts[key]);
        }
    }

    /** Tighten near/far to the current zoom so depth precision holds from street level to the whole corridor. */
    updateClipPlanes() {
        const distance = this.camera.position.distanceTo(this.controls.target);
        const near = Math.min(Math.max(distance / 150, 0.2), 20);
        const far = distance * 6 + 2000;
        if (Math.abs(near - this.camera.near) > 1e-3 || Math.abs(far - this.camera.far) > 1) {
            this.camera.near = near;
            this.camera.far = far;
            this.camera.updateProjectionMatrix();
        }
    }
}

/**
 * Column-major Ry(yaw) * S(length, 1, width) with translation, written straight
 * into an instance buffer. Local +x must point along the sim heading (hx, hy),
 * which in three's (x, z) plane means cos = hx, -sin = hy.
 */
function writeVehicleMatrix(array, index, car) {
    const o = index * 16;
    const length = car.lengthM ?? 4.5;
    const width = car.widthM ?? 1.9;
    array[o] = car.hx * length;
    array[o + 1] = 0;
    array[o + 2] = car.hy * length;
    array[o + 3] = 0;
    array[o + 4] = 0;
    array[o + 5] = 1;
    array[o + 6] = 0;
    array[o + 7] = 0;
    array[o + 8] = -car.hy * width;
    array[o + 9] = 0;
    array[o + 10] = car.hx * width;
    array[o + 11] = 0;
    array[o + 12] = car.x;
    array[o + 13] = 0;
    array[o + 14] = car.y;
    array[o + 15] = 1;
}

/**
 * Lambert material for the simple vehicle models: vertices tagged by the
 * geometry's `trimMask` attribute take the theme's trim colour instead of the
 * per-instance body colour, so one mesh draws both tones.
 */
function createSimpleVehicleMaterial() {
    const material = new MeshLambertMaterial();
    const trimColour = { value: new Color() };
    material.userData.trimColour = trimColour;
    material.onBeforeCompile = (shader) => {
        shader.uniforms.trimColour = trimColour;
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float trimMask;\nuniform vec3 trimColour;')
            .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb = mix(vColor.rgb, trimColour, trimMask);');
    };
    return material;
}

function writeColour(array, index, colour) {
    array[index * 3] = colour.r;
    array[index * 3 + 1] = colour.g;
    array[index * 3 + 2] = colour.b;
}

/**
 * Draw `count` instances and upload only those. An empty mesh is hidden rather
 * than flagged - with no update range three would re-upload the whole buffer.
 */
function commitInstances(mesh, count) {
    mesh.count = count;
    mesh.visible = count > 0;
    if (!count) return;
    for (const attribute of [mesh.instanceMatrix, mesh.instanceColor].filter(Boolean)) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, count * attribute.itemSize);
        attribute.needsUpdate = true;
    }
}

function bodyColourFor(shape, car) {
    if (car.vehicleType === 'bmw') return BMW_BODY_COLOUR;
    if (car.vehicleType === 'ranger') return RANGER_BODY_COLOUR;
    if (TRUCK_SHAPES.has(shape)) return truckHasColouredCab(car.id) ? TRUCK_WHITE : truckAccentFor(car.id);
    if (shape === 'bus') return busBodyColourFor(car.id);
    if (shape === 'taxi') return TAXI_BODY_COLOUR;
    return carColourFor(car.id);
}

/** Colour of a shape's `accent` part: a truck's cab, or a bus's livery stripe. */
function accentColourFor(shape, car) {
    if (shape === 'bus') {
        const body = busBodyColourFor(car.id);
        return body === TRUCK_WHITE ? BUS_STRIPE_COLOURS[idHash(car.id, 0x5bd1e995) % BUS_STRIPE_COLOURS.length] : TRUCK_WHITE;
    }
    return truckCabColourFor(car);
}

function busBodyColourFor(id) {
    return BUS_BODY_COLOURS[idHash(id, 0x3c6ef372) % BUS_BODY_COLOURS.length];
}

/** A truck's cab colour - the opposite half of bodyColourFor()'s white/coloured split. */
function truckCabColourFor(car) {
    return truckHasColouredCab(car.id) ? truckAccentFor(car.id) : TRUCK_WHITE;
}

function truckHasColouredCab(id) {
    return idHash(id, 0x27d4eb2d) % 100 < TRUCK_COLOURED_CAB_SHARE;
}

function truckAccentFor(id) {
    return TRUCK_ACCENT_COLOURS[idHash(id, 0x165667b1) % TRUCK_ACCENT_COLOURS.length];
}

/** Stable unsigned hash of a vehicle id, salted so separate cosmetic choices don't follow each other. */
function idHash(id, salt) {
    let h = Math.imul((id | 0) ^ salt, 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Body colour for a passenger car, weighted by CAR_BODY_COLOURS' shares. A
 * stable hash of the id, so it's cosmetic only and never touches the RNG - and
 * mixed differently from shapeFor()'s hash, so colour doesn't follow shape.
 */
function carColourFor(id) {
    let h = Math.imul((id | 0) ^ ((id | 0) >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    const bucket = ((h ^ (h >>> 16)) >>> 0) % 100;
    let cumulative = 0;
    for (const { share, hex } of CAR_BODY_COLOURS) {
        cumulative += share;
        if (bucket < cumulative) return hex;
    }
    return CAR_BODY_COLOURS[0].hex;
}

/**
 * Accumulates flat (y = 0) triangles for one road layer, merged into a single
 * BufferGeometry so a whole layer costs one draw call. Normals follow
 * renderer.js's offsetPolyline() convention: `{ -dy, dx }` of the local tangent.
 */
class FlatLayer {
    constructor() {
        this.positions = [];
    }

    /** Strip between two offsets (metres along the left-hand normal) of a polyline. */
    ribbon(points, offA, offB) {
        const normals = polylineNormals(points);
        for (let i = 0; i < points.length - 1; i += 1) {
            const p0 = points[i];
            const p1 = points[i + 1];
            const n0 = normals[i];
            const n1 = normals[i + 1];
            const a0 = { x: p0.x + n0.x * offA, y: p0.y + n0.y * offA };
            const b0 = { x: p0.x + n0.x * offB, y: p0.y + n0.y * offB };
            const a1 = { x: p1.x + n1.x * offA, y: p1.y + n1.y * offA };
            const b1 = { x: p1.x + n1.x * offB, y: p1.y + n1.y * offB };
            this.quad(a0, b0, b1, a1);
        }
    }

    line(points, offset, widthM) {
        this.ribbon(points, offset - widthM / 2, offset + widthM / 2);
    }

    /** Dashed line - dashes are cut along the offset polyline so curves stay evenly spaced. */
    dashed(points, offset, widthM, dashM, gapM) {
        const offsetPts = offsetPolyline(points, offset);
        const cumulative = [0];
        for (let i = 1; i < offsetPts.length; i += 1) {
            cumulative.push(cumulative[i - 1] + Math.hypot(offsetPts[i].x - offsetPts[i - 1].x, offsetPts[i].y - offsetPts[i - 1].y));
        }
        const total = cumulative[cumulative.length - 1];
        for (let s = gapM / 2; s < total; s += dashM + gapM) {
            const piece = slicePolyline(offsetPts, cumulative, s, Math.min(s + dashM, total));
            if (piece.length >= 2) this.line(piece, 0, widthM);
        }
    }

    /** Rotated rectangle centred on `centre`, `alongM` along `axis` and `acrossM` across it. */
    rect(centre, axis, alongM, acrossM) {
        const normal = { x: -axis.y, y: axis.x };
        const ha = alongM / 2;
        const hb = acrossM / 2;
        const corner = (sa, sb) => ({
            x: centre.x + axis.x * ha * sa + normal.x * hb * sb,
            y: centre.y + axis.y * ha * sa + normal.y * hb * sb,
        });
        this.quad(corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1));
    }

    triangle(a, b, c) {
        this.positions.push(a.x, 0, a.y, b.x, 0, b.y, c.x, 0, c.y);
    }

    quad(a, b, c, d) {
        this.positions.push(a.x, 0, a.y, b.x, 0, b.y, c.x, 0, c.y, a.x, 0, a.y, c.x, 0, c.y, d.x, 0, d.y);
    }

    build() {
        if (!this.positions.length) return null;
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
        return geometry;
    }
}

/** A solid kerb-height box from `start` to `end`, `halfWidthM` either side - top, both long sides and both ends. */
function pushKerbBlock(positions, start, end, halfWidthM, heightM) {
    const lengthM = Math.hypot(end.x - start.x, end.y - start.y);
    const n = { x: -(end.y - start.y) / lengthM, y: (end.x - start.x) / lengthM };
    const corner = (p, side, y) => [p.x + n.x * halfWidthM * side, y, p.y + n.y * halfWidthM * side];
    const quad = (a, b, c, d) => positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    const [s1, s2, e1, e2] = [corner(start, 1, heightM), corner(start, -1, heightM), corner(end, 1, heightM), corner(end, -1, heightM)];
    const [s1b, s2b, e1b, e2b] = [corner(start, 1, 0), corner(start, -1, 0), corner(end, 1, 0), corner(end, -1, 0)];
    quad(s1, e1, e2, s2);
    quad(s1b, e1b, e1, s1);
    quad(s2, e2, e2b, s2b);
    quad(s1b, s1, s2, s2b);
    quad(e1, e1b, e2b, e2);
}

function smoothstep(edge0, edge1, x) {
    const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
    return t * t * (3 - 2 * t);
}

function polylineNormals(points) {
    return points.map((_, i) => {
        const prev = points[Math.max(0, i - 1)];
        const next = points[Math.min(points.length - 1, i + 1)];
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const len = Math.hypot(dx, dy) || 1;
        return { x: -dy / len, y: dx / len };
    });
}

function offsetPolyline(points, offset) {
    const normals = polylineNormals(points);
    return points.map((p, i) => ({ x: p.x + normals[i].x * offset, y: p.y + normals[i].y * offset }));
}

/** Sub-polyline covering arc length [s0, s1]. */
function slicePolyline(points, cumulative, s0, s1) {
    const at = (s) => {
        let i = 1;
        while (i < cumulative.length - 1 && cumulative[i] < s) i += 1;
        const segLen = cumulative[i] - cumulative[i - 1] || 1;
        const t = (s - cumulative[i - 1]) / segLen;
        return {
            i,
            point: {
                x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
                y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
            },
        };
    };
    const start = at(s0);
    const end = at(s1);
    const out = [start.point];
    for (let i = start.i; i < end.i; i += 1) out.push(points[i]);
    out.push(end.point);
    return out;
}
