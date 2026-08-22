# Batch run output

`results/<condition>/<seed>.csv` plus a matching `<seed>.json` summary, written by
the headless batch runner - `batch/runBatch.mjs` (CLI, build step 13) or the
`/results` page's "Generate dataset" button (browser, build step 17), both of
which call the same isomorphic `resources/js/sim/runHeadless.js`.

Empty until one of those has actually been run - nothing here is committed.

This folder stays the source of truth even after the `simulation_runs` table
lands: the database stores one summary row per run, so the per-tick time series
the recovery chart needs (`ResultsController::csvRecoveryTimeline()`) only
exists here. Run `python analysis/analyze.py` (build step 20) once a real
dataset exists in `simulation_runs` for the paired significance tests.
