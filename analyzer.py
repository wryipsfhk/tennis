"""Pose-only tennis movement review using MediaPipe Pose and OpenCV.

This module deliberately does not locate the ball or infer ball contact. Findings are
attached to distinct body-motion windows and describe only measurements supported by
continuous player keypoints.
"""

import math
import os
import uuid
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(__file__).resolve().parent / "data" / ".mpl"))

import cv2
import mediapipe as mp
import numpy as np


ROOT = Path(__file__).resolve().parent
FRAME_DIR = ROOT / "data" / "analysis"
FRAME_DIR.mkdir(parents=True, exist_ok=True)


def clamp(value, low=0.0, high=1.0):
    return max(low, min(high, value))


def point_angle(a, b, c):
    ba = np.array([a[0] - b[0], a[1] - b[1]])
    bc = np.array([c[0] - b[0], c[1] - b[1]])
    denominator = np.linalg.norm(ba) * np.linalg.norm(bc)
    if denominator <= 1e-8:
        return 180.0
    cosine = np.clip(np.dot(ba, bc) / denominator, -1.0, 1.0)
    return float(np.degrees(np.arccos(cosine)))


def percentile(values, amount, fallback=0.0):
    return float(np.percentile(values, amount)) if values else fallback


def smooth(values, radius=2):
    if not values:
        return []
    return [float(np.mean(values[max(0, i - radius):min(len(values), i + radius + 1)])) for i in range(len(values))]


def check(label, status, measured, feedback, **extra):
    return {"label": label, "status": status, "measured": measured, "feedback": feedback, **extra}


def _video_metadata(video_path):
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("This video could not be read. Upload an MP4, MOV, or WebM file.")
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 30.0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if frame_count < max(48, round(fps * 2.0)):
        capture.release()
        raise ValueError("This video is too short for a multi-window review. Upload at least two seconds with the full player visible.")
    return capture, frame_count, fps, width, height


def _overlap(box_a, box_b):
    ax, ay, aw, ah = box_a
    bx, by, bw, bh = box_b
    left, top = max(ax, bx), max(ay, by)
    right, bottom = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    union = aw * ah + bw * bh - intersection
    return intersection / union if union > 0 else 0.0


def detect_players(video_path):
    """Aggregate people detections across time instead of trusting a single frame."""
    capture, frame_count, _, _, _ = _video_metadata(video_path)
    detector = cv2.HOGDescriptor()
    detector.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    tracks = []
    samples = np.linspace(0, frame_count - 1, 9, dtype=int)
    for sample_index, frame_index in enumerate(samples):
        capture.set(cv2.CAP_PROP_POS_FRAMES, int(frame_index))
        ok, frame = capture.read()
        if not ok:
            continue
        original_h, original_w = frame.shape[:2]
        if original_w > 960:
            scale = 960 / original_w
            frame = cv2.resize(frame, (960, int(original_h * scale)))
        height, width = frame.shape[:2]
        boxes, weights = detector.detectMultiScale(frame, winStride=(8, 8), padding=(8, 8), scale=1.05)
        detections = []
        for (x, y, w, h), weight in sorted(zip(boxes, weights), key=lambda item: float(item[1]), reverse=True):
            box = (x / width, y / height, w / width, h / height)
            if float(weight) < 0.12 or box[3] < 0.12:
                continue
            if any(_overlap(box, existing[0]) > 0.45 for existing in detections):
                continue
            detections.append((box, float(weight)))
        for box, weight in detections[:5]:
            cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
            match = None
            for track in tracks:
                tx, ty = track["center"]
                if math.hypot(cx - tx, cy - ty) < max(0.10, 0.45 * max(box[3], track["box"][3])):
                    match = track
                    break
            if match is None:
                tracks.append({"center": (cx, cy), "box": box, "hits": 1, "score": max(0.05, weight), "frame": frame.copy(), "sample": sample_index})
            else:
                alpha = 0.35
                match["center"] = ((1 - alpha) * match["center"][0] + alpha * cx, (1 - alpha) * match["center"][1] + alpha * cy)
                match["box"] = tuple((1 - alpha) * old + alpha * new for old, new in zip(match["box"], box))
                match["hits"] += 1
                match["score"] += max(0.05, weight)
                if weight >= match["score"] / match["hits"]:
                    match["frame"] = frame.copy()
                    match["sample"] = sample_index
    capture.release()

    tracks = [track for track in tracks if track["hits"] >= 2]
    tracks.sort(key=lambda track: (track["hits"], track["score"]), reverse=True)
    used_fallback = not tracks
    if used_fallback:
        capture = cv2.VideoCapture(str(video_path))
        capture.set(cv2.CAP_PROP_POS_FRAMES, frame_count // 2)
        ok, frame = capture.read()
        capture.release()
        if not ok:
            raise ValueError("No readable video frames were found.")
        if frame.shape[1] > 960:
            scale = 960 / frame.shape[1]
            frame = cv2.resize(frame, (960, int(frame.shape[0] * scale)))
        tracks = [{"center": (0.5, 0.5), "box": (0.0, 0.0, 1.0, 1.0), "hits": 1, "score": 0.0, "frame": frame, "sample": 4}]

    candidates = []
    colors = [(81, 244, 221), (176, 197, 68), (95, 118, 239), (255, 255, 255)]
    for index, track in enumerate(tracks[:4]):
        frame = track["frame"].copy()
        height, width = frame.shape[:2]
        bx, by, bw, bh = track["box"]
        x, y, w, h = int(bx * width), int(by * height), int(bw * width), int(bh * height)
        color = colors[index % len(colors)]
        cv2.rectangle(frame, (x, y), (min(width - 1, x + w), min(height - 1, y + h)), color, max(2, width // 320))
        cv2.putText(frame, "PLAYER %d" % (index + 1), (max(8, x), max(24, y - 9)), cv2.FONT_HERSHEY_SIMPLEX, .65, color, 2)
        name = "%s.jpg" % uuid.uuid4().hex
        cv2.imwrite(str(FRAME_DIR / name), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 84])
        cx, cy = track["center"]
        vertical = "near-court" if cy > 0.52 else "far-court"
        horizontal = "left-side" if cx < 0.5 else "right-side"
        candidates.append({
            "id": str(index + 1),
            "label": "Main player in frame" if used_fallback else "%s, %s player" % (vertical, horizontal),
            "thumbnail": "/data/analysis/%s" % name,
            "bbox": [round(value, 5) for value in track["box"]],
            "detectionFrames": track["hits"],
            "selectionConfidence": round(clamp(track["hits"] / max(3, len(samples))) * 100),
        })
    return candidates


def _expanded_crop(frame, center, box_size):
    height, width = frame.shape[:2]
    cx, cy = center[0] * width, center[1] * height
    crop_w = max(box_size[0] * width * 2.35, width * 0.42)
    crop_h = max(box_size[1] * height * 1.65, height * 0.58)
    x0 = max(0, int(cx - crop_w / 2)); x1 = min(width, int(cx + crop_w / 2))
    y0 = max(0, int(cy - crop_h / 2)); y1 = min(height, int(cy + crop_h / 2))
    return frame[y0:y1, x0:x1], (x0, y0, x1 - x0, y1 - y0)


def _record_from_pose(frame, crop_rect, result, index, fps, full_size):
    lm = result.pose_landmarks.landmark
    P = mp.solutions.pose.PoseLandmark
    x0, y0, crop_w, crop_h = crop_rect
    full_w, full_h = full_size

    def local(part):
        point = lm[part]
        return (float(point.x), float(point.y))

    def global_point(part):
        point = lm[part]
        return ((x0 + point.x * crop_w) / full_w, (y0 + point.y * crop_h) / full_h)

    keys = [P.NOSE, P.LEFT_SHOULDER, P.RIGHT_SHOULDER, P.LEFT_ELBOW, P.RIGHT_ELBOW, P.LEFT_WRIST, P.RIGHT_WRIST, P.LEFT_HIP, P.RIGHT_HIP, P.LEFT_KNEE, P.RIGHT_KNEE, P.LEFT_ANKLE, P.RIGHT_ANKLE]
    quality = float(np.mean([clamp(getattr(lm[key], "visibility", 1.0)) for key in keys]))
    global_points = {key.name.lower(): global_point(key) for key in keys}
    left_knee = point_angle(global_points["left_hip"], global_points["left_knee"], global_points["left_ankle"])
    right_knee = point_angle(global_points["right_hip"], global_points["right_knee"], global_points["right_ankle"])
    shoulder_angle = math.degrees(math.atan2(global_points["right_shoulder"][1] - global_points["left_shoulder"][1], global_points["right_shoulder"][0] - global_points["left_shoulder"][0]))
    hip_angle = math.degrees(math.atan2(global_points["right_hip"][1] - global_points["left_hip"][1], global_points["right_hip"][0] - global_points["left_hip"][0]))
    hip_x = (global_points["left_hip"][0] + global_points["right_hip"][0]) / 2
    hip_y = (global_points["left_hip"][1] + global_points["right_hip"][1]) / 2
    xs = [point[0] for point in global_points.values()]
    ys = [point[1] for point in global_points.values()]
    return {
        "frame": frame, "landmarks": result.pose_landmarks, "index": int(index), "time": index / fps,
        "pose_quality": quality, "body_center": (hip_x, hip_y), "body_box": (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)),
        "knee": min(left_knee, right_knee), "shoulder_angle": shoulder_angle, "hip_angle": hip_angle,
        "left_elbow": point_angle(global_points["left_shoulder"], global_points["left_elbow"], global_points["left_wrist"]),
        "right_elbow": point_angle(global_points["right_shoulder"], global_points["right_elbow"], global_points["right_wrist"]),
        "head_y": global_points["nose"][1], "hip_x": hip_x, "hip_y": hip_y,
        **{name + "_x": point[0] for name, point in global_points.items()},
        **{name + "_y": point[1] for name, point in global_points.items()},
        "local": {key.name.lower(): local(key) for key in keys},
        "visibility": {key.name.lower(): clamp(getattr(lm[key], "visibility", 1.0)) for key in keys},
    }


def _window_metrics(window, peak, side):
    shoulders = [math.hypot(r["right_shoulder_x"] - r["left_shoulder_x"], r["right_shoulder_y"] - r["left_shoulder_y"]) for r in window]
    shoulder_ref = max(percentile(shoulders, 50, 0.05), 0.035)
    shoulder_centers = [((r["left_shoulder_x"] + r["right_shoulder_x"]) / 2, (r["left_shoulder_y"] + r["right_shoulder_y"]) / 2) for r in window]
    hip_centers = [(r["hip_x"], r["hip_y"]) for r in window]
    torso_ref = max(percentile([math.hypot(s[0] - h[0], s[1] - h[1]) for s, h in zip(shoulder_centers, hip_centers)], 50, 0.08), 0.045)
    ankle_records = [r for r in window if min(r["visibility"]["left_ankle"], r["visibility"]["right_ankle"], r["visibility"]["left_hip"], r["visibility"]["right_hip"]) >= 0.62]
    stance = [abs(r["right_ankle_x"] - r["left_ankle_x"]) / shoulder_ref for r in ankle_records]
    balance_samples = []
    for record in ankle_records:
        foot_min, foot_max = sorted((record["left_ankle_x"], record["right_ankle_x"]))
        margin = max((foot_max - foot_min) * 0.10, 0.012)
        balance_samples.append(foot_min - margin <= record["hip_x"] <= foot_max + margin)
    wrist_records = [r for r in window if r["visibility"][f"{side}_wrist"] >= 0.60]
    wrist_points = [(r[f"{side}_wrist_x"], r[f"{side}_wrist_y"]) for r in wrist_records]
    wrist_travel = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(wrist_points, wrist_points[1:])) / shoulder_ref
    direct = math.hypot(wrist_points[-1][0] - wrist_points[0][0], wrist_points[-1][1] - wrist_points[0][1]) / shoulder_ref if len(wrist_points) > 1 else 0
    knee_records = [r for r in window if min(r["visibility"]["left_knee"], r["visibility"]["right_knee"], r["visibility"]["left_ankle"], r["visibility"]["right_ankle"]) >= 0.58]
    head_records = [r for r in window if r["visibility"]["nose"] >= 0.65]
    torso_angles = [r["shoulder_angle"] - r["hip_angle"] for r in window]
    shoulder_angles = [r["shoulder_angle"] for r in window]
    projected_turn = percentile([abs(b - a) for a, b in zip(shoulder_angles, shoulder_angles[1:])], 90)
    body_centers = [r["body_center"] for r in window]
    center_path = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(body_centers, body_centers[1:])) / shoulder_ref
    return {
        "id": peak["window_id"], "start": window[0]["time"], "end": window[-1]["time"], "time": peak["time"],
        "peak": peak, "window": window, "samples": len(window), "quality": float(np.mean([r["pose_quality"] for r in window])),
        "stance": float(np.median(stance)) if stance else None, "balance": 100 * sum(balance_samples) / len(balance_samples) if balance_samples else None,
        "knee": min((r["knee"] for r in knee_records), default=None), "swing": wrist_travel if len(wrist_points) >= 4 else None, "swing_direct": direct,
        "head": (max(r["head_y"] for r in head_records) - min(r["head_y"] for r in head_records)) / torso_ref if len(head_records) >= 4 else None,
        "torso_separation": max(torso_angles) - min(torso_angles), "projected_turn": projected_turn, "center_path": center_path,
        "reliability": {"ankles": len(ankle_records) / len(window), "knees": len(knee_records) / len(window), "wrist": len(wrist_records) / len(window), "head": len(head_records) / len(window)},
    }


def _candidates_for_window(metric):
    items = []
    common = {"window": metric, "sample_count": metric["samples"]}
    if metric["balance"] is not None and metric["reliability"]["ankles"] >= 0.67 and metric["balance"] < 66:
        items.append({**common, "key": "balance", "severity": clamp((72 - metric["balance"]) / 42), "label": "Hip centre leaves the visible support base", "check": "Balance stability", "measured": "Hip centre stayed between the feet in %d%% of this window" % round(metric["balance"]), "feedback": "In this exact movement window, the projected hip centre passes outside the area between the visible ankles. The finish therefore relies on a recovery step rather than a stable base. Practise the same movement more slowly, keep the chest over the support base, hold the finish for two seconds, then recover.", "exercise": "Swing-and-hold balance drill · 3 × 8 reps"})
    if metric["stance"] is not None and metric["reliability"]["ankles"] >= 0.67 and metric["stance"] < 0.66:
        items.append({**common, "key": "stance_narrow", "severity": clamp((0.72 - metric["stance"]) / 0.42), "label": "Stance closes during the movement", "check": "Stance width", "measured": "Foot spacing was %.2f × shoulder width in this window" % metric["stance"], "feedback": "The visible ankles are closer together than two-thirds of shoulder width at this movement peak. That reduces the base available for lateral control. Arrive with small adjustment steps and establish a comfortable shoulder-width base before the forward movement begins.", "exercise": "Split step to shoulder-width base · 3 × 12 reps"})
    elif metric["stance"] is not None and metric["reliability"]["ankles"] >= 0.67 and metric["stance"] > 2.20:
        items.append({**common, "key": "stance_wide", "severity": clamp((metric["stance"] - 2.1) / 1.2), "label": "Stance remains too wide to recover cleanly", "check": "Stance width", "measured": "Foot spacing was %.2f × shoulder width in this window" % metric["stance"], "feedback": "The visible ankles remain more than twice shoulder width apart through this movement peak. The base is stable but restricts the first recovery step. Let the outside foot move back under the body as the follow-through finishes.", "exercise": "Wide-base swing into recovery step · 3 × 10 reps"})
    if metric["knee"] is not None and metric["reliability"]["knees"] >= 0.67 and metric["knee"] > 160:
        items.append({**common, "key": "lower_body", "severity": clamp((metric["knee"] - 157) / 23), "label": "Lower body stays upright through preparation", "check": "Lower-body preparation", "measured": "Smallest visible knee angle was %d° in this window" % round(metric["knee"]), "feedback": "Both visible knee angles remain close to straight throughout this movement window. The body therefore begins the forward action from an upright base. Add a small athletic knee bend before the forward movement, then extend only as the body drives upward or forward.", "exercise": "Load-and-rise shadow swings · 3 × 10 reps"})
    if metric["swing"] is not None and metric["reliability"]["wrist"] >= 0.67 and metric["swing"] < 1.15:
        items.append({**common, "key": "swing_path", "severity": clamp((1.25 - metric["swing"]) / 0.9), "label": "Racket-side wrist path is abbreviated", "check": "Swing path", "measured": "Visible wrist path was %.2f × shoulder width in this window" % metric["swing"], "feedback": "The racket-side wrist covers less than roughly one-and-a-quarter shoulder widths across the complete visible movement window. The body pose shows preparation and finish close together. Rehearse a slower uninterrupted path from preparation through follow-through, keeping the torso and arm moving as one sequence.", "exercise": "Slow full-path shadow swings · 3 × 8 reps"})
    if metric["head"] is not None and metric["reliability"]["head"] >= 0.75 and 0.82 < metric["head"] < 1.65:
        items.append({**common, "key": "head", "severity": clamp((metric["head"] - 0.68) / 0.75), "label": "Head height changes sharply during the movement", "check": "Posture stability", "measured": "Vertical head travel was %.2f × torso length in this window" % metric["head"], "feedback": "The nose keypoint changes height by more than four-fifths of the visible shoulder-to-hip length inside this movement window. The torso is rising or dropping abruptly before the movement finishes. Rehearse beside a fixed visual marker and keep head height steady until the forward path is established.", "exercise": "Level-head shadow swings · 3 × 8 reps"})
    return items


def _draw_evidence(metric, finding, side):
    record = metric["peak"]
    output = record["frame"].copy()
    mp.solutions.drawing_utils.draw_landmarks(output, record["landmarks"], mp.solutions.pose.POSE_CONNECTIONS)
    height, width = output.shape[:2]
    local = record["local"]
    color = (67, 83, 234)
    if finding["check"] in {"Balance stability", "Stance width"}:
        left, right = local["left_ankle"], local["right_ankle"]
        cv2.line(output, (int(left[0] * width), int(left[1] * height)), (int(right[0] * width), int(right[1] * height)), color, 4)
    elif finding["check"] == "Lower-body preparation":
        for name in ("left_knee", "right_knee"):
            point = local[name]
            cv2.circle(output, (int(point[0] * width), int(point[1] * height)), max(7, width // 85), color, 3)
    elif finding["check"] == "Swing path":
        trail = np.array([(int(r["local"][f"{side}_wrist"][0] * width), int(r["local"][f"{side}_wrist"][1] * height)) for r in metric["window"]], dtype=np.int32)
        if len(trail) > 1:
            cv2.polylines(output, [trail], False, color, 4)
    else:
        nose = local["nose"]
        cv2.line(output, (0, int(nose[1] * height)), (width, int(nose[1] * height)), color, 3)
    name = "%s.jpg" % uuid.uuid4().hex
    cv2.imwrite(str(FRAME_DIR / name), output, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    return "/data/analysis/%s" % name


def analyze_video(video_path, movement="match", player_bbox=None, forced_contact_time=None):
    """Review distinct pose windows; ``forced_contact_time`` is ignored for compatibility."""
    del forced_contact_time
    capture, frame_count, fps, _, _ = _video_metadata(video_path)
    duration = frame_count / fps
    sample_count = min(720, max(48, int(duration * 6)))
    indices = np.unique(np.linspace(0, frame_count - 1, sample_count, dtype=int))
    bbox = [float(value) for value in (player_bbox or [0, 0, 1, 1])]
    center = (clamp(bbox[0] + bbox[2] / 2), clamp(bbox[1] + bbox[3] / 2))
    box_size = (clamp(bbox[2], 0.08, 1.0), clamp(bbox[3], 0.12, 1.0))
    initial_center = center
    records, rejected_jumps = [], 0
    pose_module = mp.solutions.pose
    with pose_module.Pose(static_image_mode=True, model_complexity=1, min_detection_confidence=0.5) as pose:
        for index in indices:
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
            ok, full_frame = capture.read()
            if not ok:
                continue
            if full_frame.shape[1] > 960:
                scale = 960 / full_frame.shape[1]
                full_frame = cv2.resize(full_frame, (960, int(full_frame.shape[0] * scale)))
            full_h, full_w = full_frame.shape[:2]
            crop, crop_rect = _expanded_crop(full_frame, center, box_size)
            if crop.size == 0:
                continue
            result = pose.process(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
            if not result.pose_landmarks:
                continue
            record = _record_from_pose(crop, crop_rect, result, int(index), fps, (full_w, full_h))
            distance = math.hypot(record["body_center"][0] - center[0], record["body_center"][1] - center[1])
            initial_distance = math.hypot(record["body_center"][0] - initial_center[0], record["body_center"][1] - initial_center[1])
            gate = max(0.15, box_size[1] * 0.72)
            if records and (distance > gate or initial_distance > max(0.30, box_size[1] * 1.35)):
                rejected_jumps += 1
                continue
            center = (0.82 * center[0] + 0.18 * record["body_center"][0], 0.82 * center[1] + 0.18 * record["body_center"][1])
            records.append(record)
    capture.release()

    coverage = len(records) / len(indices) if len(indices) else 0
    if len(records) < 12 or coverage < 0.22:
        raise ValueError("The selected player was not tracked continuously enough. Choose the correct player and use a fixed video with the full body visible.")

    for side in ("left", "right"):
        raw = []
        previous = None
        for record in records:
            speed = 0.0
            if previous is not None:
                elapsed = max(record["time"] - previous["time"], 1 / fps)
                distance = math.hypot(record[f"{side}_wrist_x"] - previous[f"{side}_wrist_x"], record[f"{side}_wrist_y"] - previous[f"{side}_wrist_y"])
                shoulder_width = max(math.hypot(record["right_shoulder_x"] - record["left_shoulder_x"], record["right_shoulder_y"] - record["left_shoulder_y"]), 0.035)
                speed = distance / shoulder_width / elapsed
            raw.append(speed)
            previous = record
        for record, value in zip(records, smooth(raw, 2)):
            record[f"{side}_speed"] = value
    for index, record in enumerate(records):
        prior = records[max(0, index - 1)]
        elapsed = max(record["time"] - prior["time"], 1 / fps)
        hip_speed = math.hypot(record["hip_x"] - prior["hip_x"], record["hip_y"] - prior["hip_y"]) / elapsed
        shoulder_change = abs(record["shoulder_angle"] - prior["shoulder_angle"]) / elapsed / 90
        record["motion_energy"] = 0.48 * max(record["left_speed"], record["right_speed"]) + 0.30 * min(hip_speed * 8, 3) + 0.22 * shoulder_change

    side = max(("left", "right"), key=lambda value: percentile([r[f"{value}_speed"] for r in records], 90))
    energy_values = [r["motion_energy"] for r in records]
    threshold = max(percentile(energy_values, 68), percentile(energy_values, 50) * 1.25)
    local_peaks = []
    for index in range(2, len(records) - 2):
        value = energy_values[index]
        if value >= threshold and value == max(energy_values[index - 2:index + 3]):
            local_peaks.append(records[index])
    local_peaks.sort(key=lambda item: item["motion_energy"], reverse=True)
    peaks = []
    minimum_gap = max(1.5, min(3.0, duration / 8))
    for candidate in local_peaks:
        if all(abs(candidate["time"] - existing["time"]) >= minimum_gap for existing in peaks):
            peaks.append(candidate)
        if len(peaks) >= 6:
            break
    peaks.sort(key=lambda item: item["time"])
    if len(peaks) < 2:
        ranked = sorted(records, key=lambda item: item["motion_energy"], reverse=True)
        for candidate in ranked:
            if all(abs(candidate["time"] - existing["time"]) >= minimum_gap for existing in peaks):
                peaks.append(candidate)
            if len(peaks) >= min(3, max(2, round(duration / 12))):
                break
        peaks.sort(key=lambda item: item["time"])

    metrics = []
    for number, peak in enumerate(peaks, 1):
        peak["window_id"] = "W%02d" % number
        window = [record for record in records if peak["time"] - 0.9 <= record["time"] <= peak["time"] + 1.0]
        if len(window) >= 6:
            metrics.append(_window_metrics(window, peak, side))

    mean_quality = float(np.mean([r["pose_quality"] for r in records]))
    continuity = clamp(1 - rejected_jumps / max(len(records) + rejected_jumps, 1))
    window_score = clamp(len(metrics) / 4)
    movement_confidence = min(94, round(100 * (0.40 * clamp(coverage) + 0.25 * mean_quality + 0.20 * continuity + 0.15 * window_score)))
    tracking = {"coverage": round(coverage * 100), "continuity": round(continuity * 100), "rejectedPlayerJumps": rejected_jumps, "selectedPlayer": True}
    capabilities = {"poseTracking": True, "multiWindow": True, "playerTracking": True, "ballTracking": False, "contactDetection": False}

    if movement_confidence < 45 or len(metrics) < 2:
        return {
            "analysisVersion": 7, "analysisMode": "pose-only-multi-window-v2", "movementConfidence": movement_confidence,
            "movement": movement, "movementName": "Full match · Pose movement review", "coverage": round(coverage * 100),
            "overall": "The selected player was not clear enough across multiple distinct movement windows for a technical report.",
            "checks": [check("Player tracking", "unknown", "%d distinct movement windows" % len(metrics), "Use a fixed camera, keep the selected player fully visible, and avoid other players crossing in front of them.")],
            "frames": [], "events": [], "goal": "", "exercises": [], "tracking": tracking, "capabilities": capabilities,
            "ballTracking": False, "contactDetected": False,
        }

    all_findings = [finding for metric in metrics for finding in _candidates_for_window(metric)]
    key_counts = {key: sum(1 for finding in all_findings if finding["key"] == key) for key in {finding["key"] for finding in all_findings}}
    for finding in all_findings:
        repeat_support = key_counts[finding["key"]] / len(metrics)
        finding["confidence"] = round(100 * clamp(0.50 * finding["window"]["quality"] + 0.25 * continuity + 0.25 * repeat_support))
        finding["rank"] = finding["severity"] * (0.72 + 0.28 * repeat_support) * finding["window"]["quality"]
    all_findings.sort(key=lambda item: item["rank"], reverse=True)
    selected, used_keys, used_windows = [], set(), set()
    for finding in all_findings:
        if finding["key"] in used_keys or finding["window"]["id"] in used_windows or finding["confidence"] < 55:
            continue
        selected.append(finding); used_keys.add(finding["key"]); used_windows.add(finding["window"]["id"])
        if len(selected) >= 3:
            break

    checks, frames, exercises = [], [], []
    for finding in selected:
        metric = finding["window"]
        checks.append(check(finding["check"], "warn", finding["measured"], finding["feedback"], windowId=metric["id"], timestamp=round(metric["time"], 2), confidence=finding["confidence"], sampleCount=finding["sample_count"]))
        exercises.append(finding["exercise"])
        frames.append({
            "url": _draw_evidence(metric, finding, side), "label": finding["label"], "checkLabel": finding["check"],
            "time": round(metric["time"], 2), "start": round(metric["start"], 2), "end": round(metric["end"], 2),
            "windowId": metric["id"], "confidence": finding["confidence"], "mistake": True,
        })

    good_rules = [
        ("Balance stability", lambda m: m["balance"] is not None and m["reliability"]["ankles"] >= .67 and m["balance"] >= 78, lambda values: "Hip centre stayed inside the visible support base in %d of %d reviewed windows." % (sum(values), len(values)), "The selected player's projected hip centre remained supported through most reviewed movements."),
        ("Lower-body preparation", lambda m: m["knee"] is not None and m["reliability"]["knees"] >= .67 and m["knee"] <= 155, lambda values: "Visible knee flexion appeared in %d of %d reviewed windows." % (sum(values), len(values)), "Repeated lower-body preparation is visible before the faster body movements."),
        ("Posture stability", lambda m: m["head"] is not None and m["reliability"]["head"] >= .75 and m["head"] <= 0.68, lambda values: "Head height stayed stable in %d of %d reviewed windows." % (sum(values), len(values)), "Head height remained controlled relative to torso length through most reviewed movements."),
    ]
    for label, rule, measured_text, feedback in good_rules:
        values = [rule(metric) for metric in metrics]
        if sum(values) >= max(2, math.ceil(len(values) * 0.65)) and label not in {item["label"] for item in checks}:
            status = "good" if movement_confidence >= 65 else "unknown"
            checks.append(check(label, status, measured_text(values), feedback if status == "good" else "The visible measurements are encouraging, but tracking confidence is not high enough to label this a reliable strength."))

    if selected:
        overall = "%d distinct movement windows were reviewed. The strongest supported pattern is %s at %.1f seconds." % (len(metrics), selected[0]["label"].lower(), selected[0]["window"]["time"])
        goal = "Improve %s over the next 4 weeks with three focused sessions each week" % selected[0]["check"].lower()
    else:
        overall = "%d distinct movement windows were reviewed. No repeated movement pattern crossed the reporting threshold." % len(metrics)
        goal = ""

    events = [{
        "id": m["id"], "time": round(m["time"], 2), "start": round(m["start"], 2), "end": round(m["end"], 2),
        "samples": m["samples"], "poseQuality": round(m["quality"] * 100), "motionScore": round(m["peak"]["motion_energy"], 3),
        "measurements": {
            "stanceToShoulder": round(m["stance"], 2) if m["stance"] is not None else None,
            "supportedBalancePercent": round(m["balance"]) if m["balance"] is not None else None,
            "minimumKneeAngle": round(m["knee"]) if m["knee"] is not None else None,
            "wristPathToShoulder": round(m["swing"], 2) if m["swing"] is not None else None,
            "headTravelToTorso": round(m["head"], 2) if m["head"] is not None else None,
            "projectedShoulderChange": round(m["projected_turn"], 1),
            "projectedShoulderHipSeparationChange": round(m["torso_separation"], 1),
            "bodyCenterPathToShoulder": round(m["center_path"], 2),
        },
        "jointVisibility": {name: round(value * 100) for name, value in m["reliability"].items()},
    } for m in metrics]
    return {
        "analysisVersion": 7, "analysisMode": "pose-only-multi-window-v2", "movementConfidence": movement_confidence,
        "movement": movement, "movementName": "Full match · Pose movement review", "coverage": round(coverage * 100),
        "overall": overall, "checks": checks, "frames": frames, "events": events, "goal": goal,
        "exercises": exercises if movement_confidence >= 65 else [], "tracking": tracking, "capabilities": capabilities,
        "ballTracking": False, "contactDetected": False,
        "movementMetrics": {"reviewedWindows": len(metrics), "racketSideProxy": side, "duration": round(duration, 2), "sampledFrames": len(indices), "reviewedPatterns": ["stance width", "balance support", "knee preparation", "wrist-path continuity", "head-height stability", "projected shoulder/hip coordination", "body-centre travel"]},
    }
