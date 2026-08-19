# Smart Traffic Simulator

Browser-based traffic simulator comparing **fixed-time**, **sensor-adaptive** and
**green-wave** signal control on the same corridor and the same seeded traffic,
then cutting the power mid-run to see which assumptions survive. Supports the
DST481 dissertation work on IoT-enabled smart traffic management in the South
African context.

Default scenario: Pretorius Street (inbound) and Francis Baard Street (outbound)
into Hatfield, Pretoria — two one-way 4-lane arterials, four signalised
intersections each, joined by four signalised two-way cross-streets.

---

## Status: Phase 1 complete (shell only)

The build is split shell-first / logic-second, deliberately. **Phase 1 is done:**
every page, every navigation path, every control and every visual output exists
and looks finished — and nothing computes anything real.

What that means concretely:

| Area | Phase 1 (now) | Phase 2 |
|---|---|---|
| `/simulator` road layout | Drawn from `corridors/*.json` — surfaces, lane markings, stop lines, junction boxes, unlit signal heads, block distances, pan/zoom | unchanged |
| `/simulator` controls | All present and functional as UI: they hold state, reflect it, and log to the console and to the in-page **Control state log** | same controls, wired to real logic |
| Cars, controllers, sensors, load shedding | **none** | build steps 6–14 |
| Stats footer | Real layout, two columns per arterial, every value `—` | live numbers, build step 8 |
| `/results` charts | Real charts against **hardcoded fake aggregates** in `ResultsController` | same charts, real `simulation_runs` queries, build step 22 |
| Batch runner, seeded PRNG, DB | **none** | build steps 16–21 |

The discipline that matters: **no Phase 1 control quietly grew real logic.**
`Run` flips a UI flag; there is no tick loop, no timer and no simulation state
anywhere in `resources/js/`. If you find yourself adding IDM or controller code
to make a control "actually work", that is Phase 2 arriving early.

---

## Running it locally

Served by Laravel Herd at **http://traffic-simulator.test**.

The project folder is `Traffic Simulator` (with a space), which Herd would
otherwise serve as the unusable hostname `Traffic Simulator.test`. A directory
junction gives it a clean name without needing admin rights:

```
mklink /J "%USERPROFILE%\.config\herd\config\valet\Sites\traffic-simulator" "%USERPROFILE%\Herd\Traffic Simulator"
```

(`herd link traffic-simulator` does the same thing but needs elevation, because it
creates a symlink rather than a junction.)

Setup from scratch:

```
composer install
npm install
cp .env.example .env && php artisan key:generate
php artisan migrate --seed
npm run build      # or: npm run dev
```

Sign in with `demo@traffic-simulator.test` / `password` (seeded by
`DatabaseSeeder`), or register a new account.

### Database

Phase 1 runs on **SQLite** (`database/database.sqlite`) — the only table needed
is Breeze's `users`. The spec calls for MySQL, which is only required from build
step 19 when `simulation_runs` lands; a local MySQL is listening on 3306 but its
credentials were not available at setup time. Switching is a `.env` change:

```
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_DATABASE=traffic_simulator
DB_USERNAME=...
DB_PASSWORD=...
```

### Tests

```
php artisan test
```

`tests/Feature/NavigationTest.php` encodes the Phase 1 milestone: log in, land on
`/simulator`, see the layout and every control, switch to `/results`, see the
charts and their table twins, log out. Phase 2 is not allowed to break it.

---

## Layout is data, not code

Nothing about the road network is hardcoded. `corridors/*.json` drives it:

| File | Purpose |
|---|---|
| `hatfield-pretorius-francisbaard.json` | The default scenario: 2 arterials × 4 intersections + 4 connectors |
| `two-intersection-test.json` | Build step 11 — smallest config that still exercises the loader |
| `single-intersection.json` | Build steps 6–10 — one 4-way junction, far easier to debug controllers on |

`SimulatorController` serves them at `GET /corridors/{id}`; the scenario picker
fetches on change. They live at the project root rather than in `public/` or the
JS bundle because the headless batch runner (build step 17) has to read the same
files from disk — one source of truth for both the browser and Node.

**Geometry conventions** (see `resources/js/sim/corridor.js`):

- metres; x increases east, y increases **south**, matching canvas axes
- each arterial has an `origin` and a `direction`; intersection positions are
  derived by walking the `distanceToNextM` chain, so the distances that drive the
  green-wave offsets are the same numbers that place the drawing
- **left-hand traffic** (South Africa): for a heading, the lanes carrying it and
  its signal head are on the left of the centreline

**Default scenario geometry.** Cross-streets west to east along Pretorius
(inbound/eastbound) are **Jan Shoba, Grosvenor, Hilda, Festival**, a uniform
**245 m** apart; Francis Baard runs the same block sequence in reverse, being
outbound/westbound. Because every block is the same length, the green-wave offset
chain is a constant step — 245 m ÷ 13.89 m/s ≈ **17.6 s per intersection** at the
50 km/h target speed — which makes the progression band unusually easy to verify
by hand at build step 14.

---

## Where things live

```
routes/web.php                        # /, /simulator, /corridors/{id}, /results
app/Support/CorridorRepository.php    # reads corridors/*.json
app/Http/Controllers/
  SimulatorController.php             # simulator page + corridor JSON endpoint
  ResultsController.php               # PHASE 1: hardcoded fake aggregates
corridors/*.json                      # layout configs
resources/views/
  simulator.blade.php                 # canvas, control rail, stats footer
  results.blade.php                   # charts, paired comparisons, table twins
resources/js/
  sim/corridor.js                     # config -> geometry graph
  sim/renderer.js                     # canvas draw + pan/zoom camera
  simulator.js                        # page wiring, control state, logging
  charts/theme.js                     # shared Chart.js theme + palettes
  results.js                          # dashboard charts
public/cars/                          # car sprites (empty — Phase 2)
results/                              # batch run CSV/JSON output (empty — Phase 2)
```

Not yet created, and intentionally so: `car.js`, `intersection.js`,
`controllers/`, `sensors.js`, `loadShedding.js`, `stats.js`, `rng.js`,
`batchRunner.js`, the `simulation_runs` migration and model, and
`POST /api/simulation-runs`.

## Models behind the simulation (Phase 2)

Each behaviour model has a citation rather than ad hoc rules:

- **Car following** — Intelligent Driver Model (Treiber, Hennig & Helbing, 2000)
- **Fixed-time timing** — Webster's method (Webster, 1958) for cycle length and
  phase splits, so the baseline is a legitimate implementation, not a strawman
- **Adaptive control** — threshold/gap-extension heuristic mirroring the
  sense–decide–execute ATSC loop of SCATS/SCOOT
- **Green wave** — standard progression-band coordination,
  `offset = distance / target speed`, per arterial and one-directional

## Theming

**Light is the default.** Night mode is opt-in via the toggle in the header, next
to the signed-in user; the choice is remembered in `localStorage`.

`prefers-color-scheme` is deliberately **not** consulted — a visitor with a dark
OS still gets the white UI until they ask for night mode. `NavigationTest` asserts
this, so it cannot regress by accident.

Three layers have to agree, and only the first is pure CSS:

| Layer | How it switches |
|---|---|
| Page chrome | Tailwind `dark:` variants, `darkMode: 'class'`, class on `<html>` |
| Canvas map | `PALETTES.light` / `PALETTES.dark` in `resources/js/sim/renderer.js`, repainted on toggle |
| Charts | ink swapped by `applyChartTheme()`, then every chart rebuilt |

`resources/js/theme.js` owns the state and fires `theme:change`; the simulator and
results pages subscribe via `onThemeChange`. A small inline script
(`resources/views/partials/theme-boot.blade.php`) applies the class before first
paint so the wrong theme never flashes.

The light map is not an inversion of the dark one: on a pale carriageway the lane
markings go **dark**, because white lines would be invisible.

### Chart palettes

Series colours are **identical in both themes**, which is a checked result rather
than a shortcut: every slot was validated against a white surface *and* against
the dark surface — inside the lightness band for each mode, over the chroma floor,
≥ 3:1 on the surface, and the worst adjacent pair separating by ΔE ≥ 10 under
simulated colour-vision deficiency. Holding them steady means an entity does not
change colour when you flip the theme. Only the ink (text, grid, axis, surface)
switches.

Controller modes are orange / violet / emerald; arterials are blue / orange.
Colour follows the entity, never its rank, and text never wears a series colour —
a coloured dot beside it carries identity. Re-run the validator before shifting
any of these values. See `resources/js/charts/theme.js` and
`resources/js/sim/renderer.js`.
