# Batch run output

`results/<condition>/<seed>.csv` plus a matching `<seed>.json` summary, written by
the headless batch runner (spec §9, build step 17).

Empty in Phase 1 — the batch runner is Phase 2.

This folder stays the source of truth even after the `simulation_runs` table
lands: MySQL stores one summary row per run, so the per-tick time series that the
recovery charts need only exists here.
