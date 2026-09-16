# ARTIS: Adaptive Road Traffic Intersection System

This project came out of a written spec, and most of it has now been built out phase by phase against that spec. At its core it's a browser-based traffic simulator that lets you compare three different ways of controlling traffic signals on the same stretch of road, using the same seeded traffic every time, and then cuts the power mid-run to see which of those approaches actually holds up when the lights go dark. It's modelled on a South African context, right down to the left-hand traffic and the load-shedding fallback.

The default scenario is Pretorius Street (inbound) and Francis Baard Street (outbound) into Hatfield, Pretoria: two one-way, four-lane arterials with four signalised intersections each, joined by four signalised two-way cross-streets. That layout is currently a placeholder rather than a fully accurate survey of the real corridor; more arterials are meant to be added later.

---

## Screenshots

**Simulator**, where you run, step, or fast-forward the corridor while watching fixed-time, adaptive, and green-wave control side by side.

![Simulator view of the Hatfield Pretorius / Francis Baard corridor](public/images/screenshots/simulator.png)

**Results**, aggregated across hundreds of seeded batch runs, each compared against the fixed-time baseline.

![Results dashboard summary cards](public/images/screenshots/results-summary.png)

**Recovery after a power cut**, showing how fast each controller mode gets wait time and throughput back to where they were before the cut.

![Recovery charts after a simulated power cut](public/images/screenshots/results-recovery.png)

---

## What the app actually does

The `/simulator` page draws a road layout straight from a `corridors/*.json` file: surfaces, lane markings, stop lines, junction boxes, signal heads, all pannable and zoomable. On top of that road, cars move according to the Intelligent Driver Model for car following, with MOBIL-based lane changing on top, and a mix of three truck sizes that each have their own slider so you can dial the truck share up or down (`resources/js/sim/car.js` and `engine.js`).

Signals are handled by one of four controllers, all under `resources/js/sim/controllers/`: `fixedTime.js` implements Webster's method for a real, defensible baseline rather than a strawman; `adaptive.js` is sensor-driven and can run at four different sensor fidelity levels; `greenWave.js` coordinates a progression band along the arterial; and `allWayStop.js` is what every intersection falls back to during load shedding. Sensor fidelity itself (`sensors.js`) ranges from inductive loop and magnetometer down to degraded radar and camera modes, feeding into `shouldExtendGreen()`.

While a run is going, a stats footer and charts pull live numbers out of `engine.js` snapshots, split three ways: Total, Arterial, and Side Streets. Everything is driven by a seeded PRNG (`rng.js`), so a run is byte-for-byte reproducible whether it's played in the browser or driven headlessly (`runHeadless.js`), which matters because the batch runner (`batch/runBatch.mjs`) uses that same headless path to sweep the full 12-condition experimental matrix (`experimentalMatrix.js`) and post results via `POST /api/simulation-runs` and `/api/recovery-ticks`.

The `/results` page then turns those stored runs into real charts, querying `simulation_runs` and `simulation_run_recovery_ticks` through `ResultsController`, again split by Total, Arterial, and Side Streets, with paired fixed-time comparisons and recovery-time metrics on both a throughput basis and a wait-time basis.

Beyond the core simulation there's also: lane changing and trucks, the Total/Arterial/Side-Streets scope split, wait-based recovery metrics sitting alongside the original throughput-based ones, and per-scope pre/during/post-outage segment stats. A plateau detector (`resources/js/sim/plateau.js`, `batch/warmupDiagnostics.mjs`) confirmed that the 360 second warm-up window is enough for every scope, so that number hasn't needed to move.

`tests/Feature/NavigationTest.php` guards navigation, layout, and every control against regressions: log in, land on `/simulator`, check the layout and every control are there, switch to `/results`, check the charts and their table twins, log out.

---

## The traffic counter

There's a third tab, sitting to the right of Results, for grounding all of this synthetic simulation in real footage. You upload a video of actual traffic, draw a line across the road in it, and the app counts vehicles crossing that line. It then fits a sinusoid to the observed flow so you can sanity check, or via the Results page's batch modal actually calibrate, the simulator's assumed synthetic demand against something real.

The sidebar shows your 10 most recent counts, but there's also a "View master table" button that switches to a full paginated table of every count ever made (20 per page), with every column the sidebar leaves out: corridor, street, status, upload time, duration, detected and counted totals, the car/truck/unclassified breakdown, mean flow, peak five-minute flow, and the fit's R². Each row also has a delete button, which removes the database row and cleans up both the raw and annotated video files on disk.

Two things this tab needs that the rest of the app doesn't:

- **A queue worker.** Video processing takes real time, so it runs as a queued job (`ProcessTrafficCount`) instead of synchronously:
  ```
  php artisan queue:work
  ```
  (`QUEUE_CONNECTION=database` is already set in `.env`.) There's also `scripts/queue-worker.ps1`, a small loop script meant to be registered as a Windows scheduled task (`TrafficSimQueueWorker`, on logon) so the worker just stays running without anyone having to remember to start it by hand.
- **Python and ffmpeg** on PATH, for the detection pipeline the job shells out to (`scripts/traffic_counter/count_vehicles.py`, using YOLOv8 via Ultralytics):
  ```
  pip install -r scripts/traffic_counter/requirements.txt
  ```
  Set `PYTHON_BIN` in `.env` if `python` on PATH isn't the right interpreter.

---

## Running it locally

Served by Laravel Herd at **http://traffic-simulator.test**.

The project folder is `Traffic-Simulator`. A directory junction maps it to the `traffic-simulator` hostname without needing admin rights:

```
mklink /J "%USERPROFILE%\.config\herd\config\valet\Sites\traffic-simulator" "%USERPROFILE%\Herd\Traffic-Simulator"
```

(`herd link traffic-simulator` does the same thing but needs elevation, because it creates a symlink rather than a junction.)

Setup from scratch:

```
composer install
npm install
cp .env.example .env && php artisan key:generate
php artisan migrate --seed
npm run build      # or: npm run dev
```

Sign in with `demo@traffic-simulator.test` / `password` (seeded by `DatabaseSeeder`), or register a new account.

### Database

Runs on **MySQL** (`traffic_simulator` database on `127.0.0.1:3306`), per the spec. `.env` is configured with:

```
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=traffic_simulator
DB_USERNAME=root
DB_PASSWORD=...
```

SQLite (`database/database.sqlite`) still works as a fallback if MySQL isn't available, just set `DB_CONNECTION=sqlite`.

### Tests

```
php artisan test
```

`tests/Feature/NavigationTest.php` covers the full navigation path: log in, land on `/simulator`, see the layout and every control, switch to `/results`, see the charts and their table twins, log out. `tests/Feature/TrafficCounterListTest.php` covers the master table pagination, the sidebar's 10-item limit, and both delete paths (with and without stored video files).

---

## Layout is data, not code

Nothing about the road network is hardcoded. `corridors/*.json` drives it:

| File | Purpose |
|---|---|
| `hatfield-pretorius-francisbaard.json` | The default scenario: 2 arterials x 4 intersections + 4 connectors |
| `two-intersection-test.json` | Smallest config that still exercises the loader |
| `single-intersection.json` | One 4-way junction, far easier to debug controllers on |

`SimulatorController` serves them at `GET /corridors/{id}`; the scenario picker fetches on change. They live at the project root rather than in `public/` or the JS bundle because the headless batch runner has to read the same files from disk, so there's one source of truth for both the browser and Node.

**Geometry conventions** (see `resources/js/sim/corridor.js`):

- metres; x increases east, y increases **south**, matching canvas axes
- each arterial has an `origin` and a `direction`; intersection positions are
  derived by walking the `distanceToNextM` chain, so the distances that drive the
  green-wave offsets are the same numbers that place the drawing
- **left-hand traffic** (South Africa): for a heading, the lanes carrying it and
  its signal head are on the left of the centreline

**Default scenario geometry.** Cross-streets west to east along Pretorius (inbound/eastbound) are **Jan Shoba, Grosvenor, Hilda, Festival**, a uniform **245 m** apart; Francis Baard runs the same block sequence in reverse, being outbound/westbound. Because every block is the same length, the green-wave offset chain works out to a constant step, roughly **17.6 s per intersection** (245 m divided by 13.89 m/s) at the 50 km/h target speed, which makes the progression band unusually easy to verify by hand.

---

## Where things live

```
routes/web.php                        # /, /simulator, /corridors/{id}, /results, /api/*
app/Support/CorridorRepository.php    # reads corridors/*.json
app/Http/Controllers/
  SimulatorController.php             # simulator page + corridor JSON endpoint
  ResultsController.php               # real simulation_runs / recovery_ticks queries, scoped metrics
  SimulationRunController.php         # POST /api/simulation-runs
  RecoveryTickController.php          # POST /api/recovery-ticks
  TrafficCounterController.php        # upload, status, data, video, master table list, delete
app/Models/SimulationRun.php
app/Models/TrafficCount.php
database/migrations/                  # simulation_runs + simulation_run_recovery_ticks, scoped columns
corridors/*.json                      # layout configs
resources/views/
  simulator.blade.php                 # canvas, control rail, stats footer
  results.blade.php                   # charts, paired comparisons, scoped table twins
  traffic-counter.blade.php           # upload form, sidebar, master table
resources/js/
  sim/corridor.js                     # config -> geometry graph
  sim/equations.js                    # IDM, Webster's, green-wave offset, MOBIL, Poisson arrivals, all cited
  sim/car.js                          # vehicle types (car + 3 truck sizes), IDM stepping
  sim/engine.js                       # tick loop, lane changes, sensors, load shedding
  sim/controllers/                    # fixedTime.js, adaptive.js, greenWave.js, allWayStop.js
  sim/sensors.js                      # sensor fidelity modes
  sim/rng.js                          # seeded PRNG
  sim/runHeadless.js                  # headless engine driver shared by browser + batch runner
  sim/plateau.js                      # convergence/plateau detector (warm-up verification)
  sim/experimentalMatrix.js           # the 12-condition controller x power x sensor matrix
  sim/renderer.js                     # canvas draw + pan/zoom camera
  simulator.js                        # page wiring, control state, logging
  charts/theme.js                     # shared Chart.js theme + palettes
  results.js                          # dashboard charts, scope/target filters
  traffic-counter.js                  # upload flow, sidebar, master table + pagination, delete
batch/
  runBatch.mjs                        # CLI sweep of the experimental matrix -> POST /api/simulation-runs
  warmupDiagnostics.mjs               # plateau-detector CLI, confirms WARMUP_TICKS
  verify.mjs
scripts/
  queue-worker.ps1                    # keeps `queue:work` alive as a scheduled task, for video processing
  traffic_counter/count_vehicles.py   # YOLOv8-based vehicle detection pipeline
public/cars/                          # car sprites
results/                              # batch run CSV/JSON output, populated per condition x power state
```

## Models behind the simulation

Each behaviour model has a citation rather than being an ad hoc rule someone made up:

- **Car following**: Intelligent Driver Model (Treiber, Hennig & Helbing, 2000)
- **Lane changing**: MOBIL (Kesting, Treiber & Helbing, 2007), with politeness and threshold tuned per vehicle type so trucks change lanes less readily than cars
- **Fixed-time timing**: Webster's method (Webster, 1958) for cycle length and phase splits, so the baseline is a legitimate implementation rather than a strawman
- **Adaptive control**: a threshold/gap-extension heuristic mirroring the sense, decide, execute ATSC loop of SCATS/SCOOT
- **Green wave**: standard progression-band coordination, offset equals distance divided by target speed, per arterial and one directional

## Theming

**Light is the default.** Night mode is opt-in via the toggle in the header, next to the signed-in user; the choice is remembered in `localStorage`.

`prefers-color-scheme` is deliberately **not** consulted, so a visitor with a dark OS still gets the white UI until they ask for night mode. `NavigationTest` asserts this, so it can't regress by accident.

Three layers have to agree, and only the first is pure CSS:

| Layer | How it switches |
|---|---|
| Page chrome | Tailwind `dark:` variants, `darkMode: 'class'`, class on `<html>` |
| Canvas map | `PALETTES.light` / `PALETTES.dark` in `resources/js/sim/renderer.js`, repainted on toggle |
| Charts | ink swapped by `applyChartTheme()`, then every chart rebuilt |

`resources/js/theme.js` owns the state and fires `theme:change`; the simulator and results pages subscribe via `onThemeChange`. A small inline script (`resources/views/partials/theme-boot.blade.php`) applies the class before first paint so the wrong theme never flashes.

The light map isn't just an inversion of the dark one: on a pale carriageway the lane markings go **dark**, because white lines would be invisible there.

### Chart palettes

Series colours are **identical in both themes**, and that's a checked result rather than a shortcut: every slot was validated against a white surface and against the dark surface, inside the lightness band for each mode, over the chroma floor, at least 3:1 contrast on the surface, with the worst adjacent pair separated by a colour difference of at least 10 under simulated colour-vision deficiency. Holding them steady means an entity doesn't change colour just because you flipped the theme. Only the ink (text, grid, axis, surface) switches.

Controller modes are orange, violet, and emerald; arterials are blue and orange. Colour follows the entity, never its rank, and text never wears a series colour; a coloured dot beside it carries identity instead. Re-run the validator before shifting any of these values. See `resources/js/charts/theme.js` and `resources/js/sim/renderer.js`.
