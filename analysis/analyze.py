#!/usr/bin/env python3
"""analysis/analyze.py - build step 20.

The offline statistical analysis the Phase 2 spec deliberately keeps out of
the web app: neither JS nor PHP has Shapiro-Wilk, a paired t-test, or
Wilcoxon signed-rank built in, and pulling in a stats library just to run
these once per dissertation write-up is unnecessary weight on the running
app. This is a script you run manually, once, against the real dataset.

Comparisons are PAIRED by seed: the batch runner (build steps 13/17) reuses
the same 30 seeds across every controller mode within a power state
(experimentalMatrix.js:seedForRep), so "fixed rep 5" and "adaptive rep 5"
under the same power state saw the identical arrival sequence. A difference
in their metrics is therefore attributable to the controller, not to which
random seed each happened to draw - which is what makes the paired t-test /
Wilcoxon signed-rank actually valid here rather than just conventional.

Usage:
    python analysis/analyze.py                          # reads database/database.sqlite
    python analysis/analyze.py --db path/to/other.sqlite
    python analysis/analyze.py --csv path/to/export.csv  # a simulation_runs table dumped to CSV
    python analysis/analyze.py --corridor hatfield-pretorius-francisbaard

Requires: scipy, numpy (`pip install scipy numpy`).
"""
import argparse
import csv
import sqlite3
import sys
from pathlib import Path

import numpy as np
from scipy import stats

POWER_STATES = ["normal", "load_shedding"]
SUBJECT_MODES = ["adaptive", "green_wave"]
METRICS = [
    ("avg_wait_time", "Average wait time (s/vehicle, lower is better)"),
    ("throughput_per_min", "Throughput (vehicles/min, higher is better)"),
    ("pct_cleared_without_stop", "Cleared without stopping (%, higher is better)"),
]


def load_from_sqlite(db_path, corridor=None):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    query = "SELECT * FROM simulation_runs"
    params = []
    if corridor:
        query += " WHERE corridor_config = ?"
        params.append(corridor)
    rows = [dict(r) for r in conn.execute(query, params)]
    conn.close()
    return rows


def load_from_csv(csv_path):
    with open(csv_path, newline="") as f:
        return list(csv.DictReader(f))


def rows_for(rows, mode, power):
    """One row per (seed, sensor_mode) - adaptive has up to 4 sensor variants per seed, fixed/green_wave have exactly one."""
    return [r for r in rows if r["controller_mode"] == mode and r["power_state"] == power]


def paired_by_seed(baseline_rows, subject_rows, metric):
    """
    Aligns subject rows to baseline rows by seed. If `subject_rows` has
    multiple sensor variants per seed (adaptive), the caller has already
    filtered to one sensor_mode before calling this - see main().
    """
    baseline_by_seed = {int(r["seed"]): r for r in baseline_rows}
    pairs = []
    for r in subject_rows:
        seed = int(r["seed"])
        if seed in baseline_by_seed:
            b = baseline_by_seed[seed]
            if r[metric] not in (None, "") and b[metric] not in (None, ""):
                pairs.append((float(b[metric]), float(r[metric])))
    return pairs


def cohens_d(baseline, subject):
    baseline, subject = np.asarray(baseline, dtype=float), np.asarray(subject, dtype=float)
    n1, n2 = len(baseline), len(subject)
    if n1 < 2 or n2 < 2:
        return float("nan")
    pooled_var = ((n1 - 1) * baseline.var(ddof=1) + (n2 - 1) * subject.var(ddof=1)) / (n1 + n2 - 2)
    pooled_std = np.sqrt(pooled_var)
    if pooled_std == 0:
        return float("nan")
    return (subject.mean() - baseline.mean()) / pooled_std


def analyse_pair(baseline_rows, subject_rows, metric, label):
    pairs = paired_by_seed(baseline_rows, subject_rows, metric)
    print(f"\n  {label}")
    print(f"    paired n = {len(pairs)}")

    if len(pairs) < 3:
        print("    fewer than 3 paired runs - skipping (generate more reps, or check the seeds actually match)")
        return

    baseline = np.array([p[0] for p in pairs])
    subject = np.array([p[1] for p in pairs])
    diffs = subject - baseline

    print(f"    mean: fixed={baseline.mean():.2f}  subject={subject.mean():.2f}  (delta={diffs.mean():+.2f})")

    if np.allclose(diffs, diffs[0]):
        print("    all paired differences identical - variance is zero, no test to run (check for a stuck/deterministic metric)")
        return

    w_stat, w_p = stats.shapiro(diffs)
    normal_enough = w_p > 0.05
    print(
        f"    Shapiro-Wilk on paired differences: W={w_stat:.4f}, p={w_p:.4f} "
        f"({'normal enough for the t-test' if normal_enough else 'NOT normal - prefer the Wilcoxon result'})"
    )

    t_stat, t_p = stats.ttest_rel(subject, baseline)
    print(f"    Paired t-test: t={t_stat:.4f}, p={t_p:.4f}")

    try:
        w_stat2, w_p2 = stats.wilcoxon(subject, baseline)
        print(f"    Wilcoxon signed-rank: W={w_stat2:.4f}, p={w_p2:.4f}")
    except ValueError as exc:
        print(f"    Wilcoxon signed-rank: skipped ({exc})")

    d = cohens_d(baseline, subject)
    print(f"    Cohen's d: {d:.3f}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", default="database/database.sqlite")
    parser.add_argument("--csv", default=None, help="Read from a CSV export instead of SQLite")
    parser.add_argument("--corridor", default=None, help="Restrict to one corridor_config value")
    args = parser.parse_args()

    if args.csv:
        rows = load_from_csv(args.csv)
        if args.corridor:
            rows = [r for r in rows if r["corridor_config"] == args.corridor]
    else:
        db_path = Path(args.db)
        if not db_path.exists():
            sys.exit(f"Database not found at {db_path} - pass --db or --csv, or generate the dataset first (build step 18).")
        rows = load_from_sqlite(str(db_path), args.corridor)

    if not rows:
        sys.exit("No simulation_runs rows found - generate the dataset first (build step 18).")

    print(f"Loaded {len(rows)} runs.")

    for power in POWER_STATES:
        print(f"\n{'=' * 60}\n{power.upper()}\n{'=' * 60}")
        baseline_rows = rows_for(rows, "fixed", power)
        if not baseline_rows:
            print("  no fixed-time baseline runs for this power state - skipping")
            continue

        for mode in SUBJECT_MODES:
            mode_rows = rows_for(rows, mode, power)
            if not mode_rows:
                continue

            sensor_modes = sorted({r["sensor_mode"] for r in mode_rows if r["sensor_mode"]}) or [None]
            for sensor_mode in sensor_modes:
                subject_rows = (
                    mode_rows if sensor_mode is None else [r for r in mode_rows if r["sensor_mode"] == sensor_mode]
                )
                header = f"{mode} vs fixed-time" + (f" (sensor: {sensor_mode})" if sensor_mode else "")
                print(f"\n--- {header} ---")
                for metric, label in METRICS:
                    analyse_pair(baseline_rows, subject_rows, metric, label)


if __name__ == "__main__":
    main()
