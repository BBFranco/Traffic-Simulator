#!/usr/bin/env python3
"""
Vehicle detection, tracking, counting, and demand-curve fitting for one
traffic-count video (Traffic Counter spec §6). Invoked by
`App\\Jobs\\ProcessTrafficCount` via Laravel's Process facade; reads nothing
from stdin, writes exactly one JSON object to stdout on success and a
non-zero exit code + stderr message on failure.

Detection/tracking: YOLOv8n (Ultralytics, pretrained COCO weights) with the
built-in ByteTrack tracker (`model.track(..., persist=True)`), which assigns
stable track IDs across frames without any training. COCO class 2 (car) maps
to "car"; classes 5 (bus) and 7 (truck) map to "truck" (spec's car/truck
split, buses folded into truck for the flow stats since neither the corridor
model nor the counting UI distinguishes buses separately); anything else
tracked (e.g. motorcycle) counts as "unclassified" rather than being dropped,
since it still crossed the line and belongs in total_vehicles.

Counting logic: a track is counted the first time its centroid crosses to
the other side of the user-drawn line, using the sign of the 2D cross
product between the line vector and the vector from the line's first point
to the centroid. Every track's centroid history determines its side; a sign
flip is a crossing.
"""

import argparse
import json
import shutil
import subprocess
import sys
from collections import Counter, defaultdict

import cv2
import numpy as np

# COCO class ids -> flow-stat bucket.
CAR_CLASSES = {2}
TRUCK_CLASSES = {5, 7}
TRACKED_CLASSES = CAR_CLASSES | TRUCK_CLASSES | {3}  # + motorcycle, counted as unclassified

# Subsample rather than full frame rate (spec §6 suggested 0.5-1s, aimed at signal-controlled
# arterial/intersection traffic - this app's actual corridor use case, where cars move slowly
# enough for ByteTrack's IoU-based frame-to-frame matching to hold). At that interval, fast
# traffic (highway speed, ~25-30 m/s) moves further between sampled frames than a car's own
# length, so consecutive sightings of the same vehicle no longer overlap enough to be matched
# as the same track - the tracker silently starts a new ID, which then has no crossing history
# and is never counted (confirmed against real footage: the same physical car observed as one
# track ID approaching the line, a different ID just past it). 0.25s cuts that displacement to
# roughly a third and meaningfully improves continuity, at proportionally more CPU time per
# video - still not a complete fix for genuinely highway-speed footage, which would need
# near-native frame rate to track reliably; expect some missed/split IDs there regardless.
SAMPLE_INTERVAL_SECONDS = 0.25
PEAK_WINDOW_SECONDS = 300


def parse_args():
    p = argparse.ArgumentParser(description="Count vehicles crossing a line in a traffic video.")
    p.add_argument("--video", required=True)
    p.add_argument("--line-coords", required=True, help="JSON array of {x, y} points in native video pixel space")
    p.add_argument("--lanes", required=True, type=int)
    p.add_argument("--period-seconds", required=True, type=int)
    p.add_argument("--bucket-seconds", required=True, type=int)
    p.add_argument("--annotated-output", default=None, help="If set, write an annotated QA video here (mp4, H.264)")
    p.add_argument("--model", default="yolov8n.pt")
    return p.parse_args()


def line_endpoints(line_coords):
    points = json.loads(line_coords)
    if len(points) < 2:
        raise ValueError("line_coords needs at least 2 points")
    a = np.array([points[0]["x"], points[0]["y"]], dtype=np.float64)
    b = np.array([points[-1]["x"], points[-1]["y"]], dtype=np.float64)
    return a, b


def side_of_line(a, b, point):
    """Sign of the cross product of (b-a) and (point-a) - which side of the line `point` is on."""
    v = b - a
    w = point - a
    cross = v[0] * w[1] - v[1] * w[0]
    return np.sign(cross)


def classify(class_history):
    """Most common COCO class id seen across a track's lifetime -> car/truck/unclassified."""
    if not class_history:
        return "unclassified"
    common = Counter(class_history).most_common(1)[0][0]
    if common in CAR_CLASSES:
        return "car"
    if common in TRUCK_CLASSES:
        return "truck"
    return "unclassified"


def run_detection(video_path, line_a, line_b, model_name, annotated_writer_factory):
    from ultralytics import YOLO

    model = YOLO(model_name)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_skip = max(1, round(fps * SAMPLE_INTERVAL_SECONDS))

    track_classes = defaultdict(list)  # track_id -> [coco class id, ...]
    track_last_side = {}               # track_id -> last known side of the line (-1, 0, 1)
    counted_tracks = set()
    crossings = []                     # (timestamp_seconds, "car"|"truck"|"unclassified")
    seen_track_ids = set()

    frames_processed = 0
    frame_index = -1
    annotated_writer = None
    last_frame_seconds = 0.0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame_index += 1
        if frame_index % frame_skip != 0:
            continue

        timestamp_seconds = frame_index / fps
        last_frame_seconds = timestamp_seconds
        frames_processed += 1

        results = model.track(
            frame, persist=True, classes=sorted(TRACKED_CLASSES), verbose=False, tracker="bytetrack.yaml"
        )
        result = results[0]

        just_crossed = []

        if result.boxes is not None and result.boxes.id is not None:
            boxes = result.boxes.xyxy.cpu().numpy()
            ids = result.boxes.id.cpu().numpy().astype(int)
            classes = result.boxes.cls.cpu().numpy().astype(int)

            for box, track_id, cls in zip(boxes, ids, classes):
                seen_track_ids.add(int(track_id))
                track_classes[int(track_id)].append(int(cls))

                centroid = np.array([(box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0])
                side = side_of_line(line_a, line_b, centroid)
                previous_side = track_last_side.get(int(track_id))
                track_last_side[int(track_id)] = side

                if (
                    previous_side is not None
                    and previous_side != 0
                    and side != 0
                    and side != previous_side
                    and int(track_id) not in counted_tracks
                ):
                    counted_tracks.add(int(track_id))
                    category = classify(track_classes[int(track_id)])
                    crossings.append((timestamp_seconds, category))
                    just_crossed.append(int(track_id))

        if annotated_writer_factory is not None:
            if annotated_writer is None:
                h, w = frame.shape[:2]
                annotated_writer = annotated_writer_factory(w, h, fps / frame_skip)
            annotated_writer.write(render_annotated_frame(frame, result, line_a, line_b, just_crossed, counted_tracks))

    # CAP_PROP_FRAME_COUNT must be read before release() - a released capture always
    # reports 0 for it - and is unreliable for many containers anyway, so this falls
    # back to the last processed frame's own timestamp (an underestimate of at most
    # one sample interval, negligible for bucketing purposes) whenever it's missing.
    reported_frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    duration_seconds = (reported_frame_count / fps) if reported_frame_count and fps else last_frame_seconds

    cap.release()
    if annotated_writer is not None:
        annotated_writer.release()

    return {
        "duration_seconds": float(duration_seconds),
        "frames_processed": frames_processed,
        "vehicles_detected": len(seen_track_ids),
        "crossings": crossings,
    }


def render_annotated_frame(frame, result, line_a, line_b, just_crossed_ids, counted_track_ids):
    """
    Boxes, track ID, class label, the counting line, and three distinct box states
    (spec §8) - a track being tracked but not yet counted looks meaningfully
    different from one that has been, so scrubbing through the video never leaves
    it ambiguous whether a given car has actually been counted yet:
      - green, thin: tracked, not yet counted (hasn't crossed the line)
      - red, thick: crosses the line on THIS exact frame (the counting moment)
      - blue, thin + "counted" label: already counted in an earlier frame - stays
        marked for the rest of the clip, instead of the one-frame flash being the
        only evidence a crossing ever registered.
    """
    annotated = frame.copy()
    line_colour = (0, 255, 255) if not just_crossed_ids else (0, 0, 255)
    cv2.line(annotated, tuple(line_a.astype(int)), tuple(line_b.astype(int)), line_colour, 3)

    if result.boxes is not None and result.boxes.id is not None:
        boxes = result.boxes.xyxy.cpu().numpy()
        ids = result.boxes.id.cpu().numpy().astype(int)
        classes = result.boxes.cls.cpu().numpy().astype(int)
        names = result.names

        for box, track_id, cls in zip(boxes, ids, classes):
            track_id = int(track_id)
            just_crossed = track_id in just_crossed_ids
            already_counted = track_id in counted_track_ids

            if just_crossed:
                colour, thickness, suffix = (0, 0, 255), 3, ""
            elif already_counted:
                colour, thickness, suffix = (255, 140, 0), 1, " [counted]"
            else:
                colour, thickness, suffix = (0, 200, 0), 1, ""

            x1, y1, x2, y2 = box.astype(int)
            cv2.rectangle(annotated, (x1, y1), (x2, y2), colour, thickness)
            label = f"#{track_id} {names.get(int(cls), str(cls))}{suffix}"
            cv2.putText(annotated, label, (x1, max(0, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, colour, 1, cv2.LINE_AA)

    return annotated


def bucket_series(crossings, duration_seconds, bucket_seconds, lanes):
    """
    Aggregate raw crossing events into fixed-width buckets, converting the
    carriageway's total crossing count into veh/lane/min (spec §6's
    per-lane conversion, done before the sinusoid fit below).
    """
    n_buckets = max(1, int(np.ceil(duration_seconds / bucket_seconds)))
    cars = [0] * n_buckets
    trucks = [0] * n_buckets
    unclassified = [0] * n_buckets

    for timestamp, category in crossings:
        idx = min(n_buckets - 1, int(timestamp // bucket_seconds))
        if category == "car":
            cars[idx] += 1
        elif category == "truck":
            trucks[idx] += 1
        else:
            unclassified[idx] += 1

    buckets = []
    for i in range(n_buckets):
        start = i * bucket_seconds
        window_seconds = min(bucket_seconds, duration_seconds - start) or bucket_seconds
        total = cars[i] + trucks[i] + unclassified[i]
        vehicles_per_min = (total / (window_seconds / 60.0)) / lanes
        buckets.append(
            {
                "bucket_start_seconds": start,
                "vehicles_per_min": round(vehicles_per_min, 3),
                "cars": cars[i],
                "trucks": trucks[i] + unclassified[i],  # unclassified folded into "trucks" column, spec's 2-column bucket table
            }
        )

    return buckets


def peak_window_flow(crossings, duration_seconds, lanes):
    """Max veh/lane/min over any fixed 300s window, independent of the caller's bucket size."""
    return max(
        (b["vehicles_per_min"] for b in bucket_series(crossings, duration_seconds, PEAK_WINDOW_SECONDS, lanes)),
        default=0.0,
    )


def fit_sinusoid(buckets, period_seconds):
    """
    q(t) = mid + a*sin(2*pi*t/T) + b*cos(2*pi*t/T), T fixed, via ordinary
    least squares (spec §6). Both sine and cosine terms absorb the unknown
    phase between the video's start time and the simulator's demand cycle.
    """
    if len(buckets) < 3:
        # Too few points for a meaningful 3-parameter fit; degenerate but honest.
        mid = float(np.mean([b["vehicles_per_min"] for b in buckets])) if buckets else 0.0
        return {"fitted_mid": mid, "fitted_amplitude": 0.0, "fitted_r_squared": 0.0}

    # Bucket midpoint = start + half the bucket width; width is constant except possibly the last bucket.
    width = buckets[1]["bucket_start_seconds"] - buckets[0]["bucket_start_seconds"] if len(buckets) > 1 else period_seconds
    starts = np.array([b["bucket_start_seconds"] for b in buckets], dtype=np.float64)
    midpoints = starts + width / 2.0

    y = np.array([b["vehicles_per_min"] for b in buckets], dtype=np.float64)
    omega = 2 * np.pi / period_seconds
    design = np.column_stack([np.ones_like(midpoints), np.sin(omega * midpoints), np.cos(omega * midpoints)])

    coeffs, *_ = np.linalg.lstsq(design, y, rcond=None)
    mid, a, b = coeffs
    amplitude = float(np.hypot(a, b))

    predicted = design @ coeffs
    ss_res = float(np.sum((y - predicted) ** 2))
    ss_tot = float(np.sum((y - np.mean(y)) ** 2))
    r_squared = 0.0 if ss_tot == 0 else 1.0 - ss_res / ss_tot

    return {"fitted_mid": float(mid), "fitted_amplitude": amplitude, "fitted_r_squared": r_squared}


def transcode_for_browser(raw_path, final_path):
    """OpenCV's mp4v/XVID output often won't play in Chrome - re-encode with libx264 (spec §8)."""
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH - required to produce a browser-playable annotated video")
    subprocess.run(
        ["ffmpeg", "-y", "-i", raw_path, "-vcodec", "libx264", "-crf", "23", final_path],
        check=True, capture_output=True,
    )


def main():
    # PHP's caller treats stdout as one JSON object and nothing else (the contract in this
    # file's own docstring). Ultralytics doesn't honour that: importing it (or a first run
    # of model.track()) can print its own setup noise straight to stdout - a first-run
    # "Creating new Ultralytics Settings" notice, AutoUpdate checks, and even a `pip install`
    # of a missing extra like `lap` if requirements.txt ever drifts - any of which breaks
    # json.loads() on the PHP side. Redirect stdout to stderr for everything except the
    # final print, so this script's stdout contract holds regardless of what a dependency
    # decides to print.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    args = parse_args()
    line_a, line_b = line_endpoints(args.line_coords)

    annotated_writer_factory = None
    raw_annotated_path = None
    if args.annotated_output:
        raw_annotated_path = args.annotated_output + ".raw.mp4"

        def factory(w, h, out_fps):
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            return cv2.VideoWriter(raw_annotated_path, fourcc, max(out_fps, 1.0), (w, h))

        annotated_writer_factory = factory

    detection = run_detection(args.video, line_a, line_b, args.model, annotated_writer_factory)

    if raw_annotated_path:
        transcode_for_browser(raw_annotated_path, args.annotated_output)

    buckets = bucket_series(detection["crossings"], detection["duration_seconds"], args.bucket_seconds, args.lanes)
    flows = [b["vehicles_per_min"] for b in buckets]
    fit = fit_sinusoid(buckets, args.period_seconds)

    cars_count = sum(1 for _, c in detection["crossings"] if c == "car")
    trucks_count = sum(1 for _, c in detection["crossings"] if c == "truck")
    unclassified_count = sum(1 for _, c in detection["crossings"] if c == "unclassified")

    output = {
        "observation_duration_seconds": round(detection["duration_seconds"]),
        "frames_processed": detection["frames_processed"],
        "vehicles_detected": detection["vehicles_detected"],
        "total_vehicles": len(detection["crossings"]),
        "cars_count": cars_count,
        "trucks_count": trucks_count,
        "unclassified_count": unclassified_count,
        "mean_flow": round(float(np.mean(flows)), 3) if flows else 0.0,
        "min_flow": round(float(np.min(flows)), 3) if flows else 0.0,
        "max_flow": round(float(np.max(flows)), 3) if flows else 0.0,
        "std_dev": round(float(np.std(flows)), 3) if flows else 0.0,
        "peak_5min_flow": round(peak_window_flow(detection["crossings"], detection["duration_seconds"], args.lanes), 3),
        **fit,
        "buckets": buckets,
    }

    sys.stdout = real_stdout
    print(json.dumps(output))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 - top-level boundary: report to stderr, exit non-zero
        print(f"count_vehicles.py error: {e}", file=sys.stderr)
        sys.exit(1)
