"""Local tennis movement analysis using MediaPipe Pose and OpenCV."""

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


def angle(a, b, c):
    ba = np.array([a.x - b.x, a.y - b.y])
    bc = np.array([c.x - b.x, c.y - b.y])
    denominator = np.linalg.norm(ba) * np.linalg.norm(bc)
    if denominator == 0:
        return 180.0
    cosine = np.clip(np.dot(ba, bc) / denominator, -1.0, 1.0)
    return float(np.degrees(np.arccos(cosine)))


def visible(*landmarks):
    return all(getattr(point, "visibility", 1) >= 0.55 for point in landmarks)


def check(label, status, measured, feedback):
    return {"label": label, "status": status, "measured": measured, "feedback": feedback}


def detect_players(video_path):
    """Find likely players in representative frames and return selectable screenshots."""
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("This video could not be read. Upload an MP4, MOV, or WebM file.")
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if frame_count < 8:
        capture.release()
        raise ValueError("This video is too short. Upload a complete match video.")
    detector = cv2.HOGDescriptor()
    detector.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    best_frame, best_boxes = None, []
    for index in np.linspace(0, frame_count - 1, 5, dtype=int):
        capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
        ok, frame = capture.read()
        if not ok:
            continue
        height, width = frame.shape[:2]
        if width > 960:
            scale = 960 / width
            frame = cv2.resize(frame, (960, int(height * scale)))
        boxes, weights = detector.detectMultiScale(frame, winStride=(8, 8), padding=(8, 8), scale=1.05)
        ranked = sorted(zip(boxes, weights), key=lambda item: float(item[1]), reverse=True)
        filtered = []
        for (x, y, w, h), weight in ranked:
            if float(weight) < 0.15 or h < frame.shape[0] * 0.12:
                continue
            center = (x + w / 2, y + h / 2)
            if any(abs(center[0] - (bx + bw / 2)) < max(w, bw) * .35 and abs(center[1] - (by + bh / 2)) < max(h, bh) * .35 for bx, by, bw, bh in filtered):
                continue
            filtered.append((int(x), int(y), int(w), int(h)))
        if best_frame is None or len(filtered) > len(best_boxes):
            best_frame, best_boxes = frame, filtered[:4]
    capture.release()
    if best_frame is None:
        raise ValueError("No readable video frames were found.")
    height, width = best_frame.shape[:2]
    used_fallback = not best_boxes
    if used_fallback:
        best_boxes = [(0, 0, width, height)]
    candidates = []
    colors = [(217, 240, 91), (68, 197, 176), (239, 118, 95), (255, 255, 255)]
    for index, (x, y, w, h) in enumerate(best_boxes):
        output = best_frame.copy()
        color = colors[index % len(colors)]
        cv2.rectangle(output, (x, y), (x + w, y + h), color, max(2, width // 320))
        cv2.putText(output, "PLAYER %d" % (index + 1), (max(8, x), max(24, y - 9)), cv2.FONT_HERSHEY_SIMPLEX, .7, color, 2)
        name = "%s.jpg" % uuid.uuid4().hex
        cv2.imwrite(str(FRAME_DIR / name), output, [int(cv2.IMWRITE_JPEG_QUALITY), 84])
        vertical = "near-court" if y + h / 2 > height / 2 else "far-court"
        horizontal = "left-side" if x + w / 2 < width / 2 else "right-side"
        candidates.append({
            "id": str(index + 1), "label": "Main player in frame" if used_fallback else "%s, %s player" % (vertical, horizontal),
            "thumbnail": "/data/analysis/%s" % name,
            "bbox": [x / width, y / height, w / width, h / height],
        })
    return candidates


def analyze_video(video_path, movement="match", player_bbox=None, forced_contact_time=None):
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("This video could not be read. Upload an MP4, MOV, or WebM file.")
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    if frame_count < 8:
        capture.release()
        raise ValueError("This video is too short to identify a complete movement. Include preparation through follow-through.")
    duration = frame_count / fps
    sample_count = min(900, max(30, int(duration * 8)))
    indices = np.linspace(0, frame_count - 1, sample_count, dtype=int)
    if forced_contact_time is not None:
        forced_index = max(0, min(frame_count - 1, round(float(forced_contact_time) * fps)))
        indices = np.unique(np.append(indices, forced_index)).astype(int)
        sample_count = len(indices)
    pose_module = mp.solutions.pose
    drawing = mp.solutions.drawing_utils
    if player_bbox and player_bbox[2] >= .9 and player_bbox[3] >= .9:
        best_pose_box = None
        with pose_module.Pose(static_image_mode=True, model_complexity=0, min_detection_confidence=0.45) as locator:
            for locator_index in np.linspace(0, frame_count - 1, 7, dtype=int):
                capture.set(cv2.CAP_PROP_POS_FRAMES, int(locator_index))
                ok, locator_frame = capture.read()
                if not ok:
                    continue
                locator_height, locator_width = locator_frame.shape[:2]
                if locator_width > 960:
                    scale = 960 / locator_width
                    locator_frame = cv2.resize(locator_frame, (960, int(locator_height * scale)))
                located = locator.process(cv2.cvtColor(locator_frame, cv2.COLOR_BGR2RGB))
                if not located.pose_landmarks:
                    continue
                points = [point for point in located.pose_landmarks.landmark if getattr(point, "visibility", 1.0) >= .45]
                if len(points) < 12:
                    continue
                min_x, max_x = min(point.x for point in points), max(point.x for point in points)
                min_y, max_y = min(point.y for point in points), max(point.y for point in points)
                span_x, span_y = max_x - min_x, max_y - min_y
                area = span_x * span_y
                if span_y >= .10 and (best_pose_box is None or area > best_pose_box[0]):
                    best_pose_box = (area, max(0.0, min_x), max(0.0, min_y), min(1.0, span_x), min(1.0, span_y))
        if best_pose_box:
            _, bx, by, bw, bh = best_pose_box
            player_bbox = [bx, by, bw, bh]
    records = []
    with pose_module.Pose(static_image_mode=False, model_complexity=1, min_detection_confidence=0.5, min_tracking_confidence=0.5) as pose:
        for index in indices:
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(index))
            ok, frame = capture.read()
            if not ok:
                continue
            height, width = frame.shape[:2]
            if width > 960:
                scale = 960 / width
                frame = cv2.resize(frame, (960, int(height * scale)))
            if player_bbox:
                height, width = frame.shape[:2]
                bx, by, bw, bh = player_bbox
                center_x, center_y = (bx + bw / 2) * width, (by + bh / 2) * height
                crop_w = max(bw * width * 2.6, width * .48)
                crop_h = max(bh * height * 1.8, height * .62)
                x0 = max(0, int(center_x - crop_w / 2)); x1 = min(width, int(center_x + crop_w / 2))
                y0 = max(0, int(center_y - crop_h / 2)); y1 = min(height, int(center_y + crop_h / 2))
                frame = frame[y0:y1, x0:x1]
            result = pose.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            if not result.pose_landmarks:
                continue
            lm = result.pose_landmarks.landmark
            P = pose_module.PoseLandmark
            left_knee = angle(lm[P.LEFT_HIP], lm[P.LEFT_KNEE], lm[P.LEFT_ANKLE])
            right_knee = angle(lm[P.RIGHT_HIP], lm[P.RIGHT_KNEE], lm[P.RIGHT_ANKLE])
            left_elbow = angle(lm[P.LEFT_SHOULDER], lm[P.LEFT_ELBOW], lm[P.LEFT_WRIST])
            right_elbow = angle(lm[P.RIGHT_SHOULDER], lm[P.RIGHT_ELBOW], lm[P.RIGHT_WRIST])
            shoulder_angle = math.degrees(math.atan2(
                lm[P.RIGHT_SHOULDER].y - lm[P.LEFT_SHOULDER].y,
                lm[P.RIGHT_SHOULDER].x - lm[P.LEFT_SHOULDER].x,
            ))
            shoulder_y = (lm[P.LEFT_SHOULDER].y + lm[P.RIGHT_SHOULDER].y) / 2
            key_points = [lm[P.NOSE], lm[P.LEFT_SHOULDER], lm[P.RIGHT_SHOULDER], lm[P.LEFT_HIP], lm[P.RIGHT_HIP], lm[P.LEFT_KNEE], lm[P.RIGHT_KNEE], lm[P.LEFT_ANKLE], lm[P.RIGHT_ANKLE], lm[P.LEFT_WRIST], lm[P.RIGHT_WRIST]]
            pose_quality = sum(getattr(point, "visibility", 1.0) for point in key_points) / len(key_points)
            records.append({
                "frame": frame, "landmarks": result.pose_landmarks, "index": int(index),
                "knee": min(left_knee, right_knee), "shoulder": shoulder_angle,
                "left_elbow": left_elbow, "right_elbow": right_elbow,
                "left_wrist_y": lm[P.LEFT_WRIST].y, "right_wrist_y": lm[P.RIGHT_WRIST].y,
                "left_wrist_x": lm[P.LEFT_WRIST].x, "right_wrist_x": lm[P.RIGHT_WRIST].x,
                "head_y": lm[P.NOSE].y, "shoulder_y": shoulder_y,
                "left_shoulder_x": lm[P.LEFT_SHOULDER].x, "right_shoulder_x": lm[P.RIGHT_SHOULDER].x,
                "left_shoulder_y": lm[P.LEFT_SHOULDER].y, "right_shoulder_y": lm[P.RIGHT_SHOULDER].y,
                "left_ankle_x": lm[P.LEFT_ANKLE].x, "right_ankle_x": lm[P.RIGHT_ANKLE].x,
                "left_ankle_y": lm[P.LEFT_ANKLE].y, "right_ankle_y": lm[P.RIGHT_ANKLE].y,
                "left_hip_x": lm[P.LEFT_HIP].x, "right_hip_x": lm[P.RIGHT_HIP].x,
                "hip_x": (lm[P.LEFT_HIP].x + lm[P.RIGHT_HIP].x) / 2,
                "hip_y": (lm[P.LEFT_HIP].y + lm[P.RIGHT_HIP].y) / 2,
                "pose_quality": pose_quality,
            })
    capture.release()
    coverage = len(records) / sample_count if sample_count else 0
    if len(records) < 8 or coverage < 0.25:
        raise ValueError("A complete body was not detected consistently. Use a fixed, well-lit video with the full body in frame.")

    for side in ("left", "right"):
        previous = None
        for record in records:
            speed = 0.0
            if previous is not None:
                elapsed = max((record["index"] - previous["index"]) / fps, 1 / fps)
                dx = record[f"{side}_wrist_x"] - previous[f"{side}_wrist_x"]
                dy = record[f"{side}_wrist_y"] - previous[f"{side}_wrist_y"]
                speed = math.hypot(dx, dy) / elapsed
            record[f"{side}_speed"] = speed
            previous = record

    speed_percentiles = {
        side: {
            "median": float(np.percentile([record[f"{side}_speed"] for record in records], 50)),
            "high": float(np.percentile([record[f"{side}_speed"] for record in records], 95)),
        }
        for side in ("left", "right")
    }
    side = max(("left", "right"), key=lambda value: speed_percentiles[value]["high"])
    ranked_peaks = sorted(records, key=lambda record: record[f"{side}_speed"], reverse=True)
    peaks = []
    for candidate in ranked_peaks:
        candidate_time = candidate["index"] / fps
        if candidate[f"{side}_speed"] < speed_percentiles[side]["high"] * .62:
            continue
        if all(abs(candidate_time - existing["index"] / fps) >= 2.25 for existing in peaks):
            peaks.append(candidate)
        if len(peaks) >= 5:
            break
    if not peaks:
        peaks = [ranked_peaks[0]]
    peak = peaks[0]
    peak_time = peak["index"] / fps
    event_windows = []
    for event_peak in peaks:
        event_window = [record for record in records if abs(record["index"] - event_peak["index"]) / fps <= .85]
        if len(event_window) < 4:
            event_window = sorted(records, key=lambda record: abs(record["index"] - event_peak["index"]))[:6]
            event_window.sort(key=lambda record: record["index"])
        event_windows.append(event_window)
    window = event_windows[0]

    pose_quality = float(np.mean([record["pose_quality"] for record in window]))
    high_speed = speed_percentiles[side]["high"]
    median_speed = speed_percentiles[side]["median"]
    motion_signal = min(1.0, max(0.0, (high_speed - median_speed) / max(high_speed, .04) * 1.35))
    movement_confidence = min(96, round(100 * (.55 * min(1.0, coverage) + .30 * pose_quality + .15 * motion_signal)))
    movement_name = "Full match · Movement path"
    checks, frames, suggestions = [], [], []
    goal_title = "Improve movement stability over the next 4 weeks with three footwork, balance, and swing-flow sessions each week"

    if movement_confidence < 45:
        checks.append(check("Body-movement path", "unknown", "Movement clarity: %d%%" % movement_confidence, "Body landmarks were not continuous enough for a technical assessment. Use a fixed camera and keep the player larger and clearer in frame."))
        return {
            "analysisVersion": 6, "analysisMode": "multi-window-pose", "movementConfidence": movement_confidence,
            "movement": movement, "movementName": movement_name, "coverage": round(coverage * 100),
            "overall": "The body-movement path was not clear enough to produce a technical assessment.", "checks": checks, "frames": [],
            "goal": goal_title, "exercises": [],
        }

    event_metrics = []
    for event_window in event_windows:
        shoulders = [abs(record["right_shoulder_x"] - record["left_shoulder_x"]) for record in event_window]
        ankles = [abs(record["right_ankle_x"] - record["left_ankle_x"]) for record in event_window]
        balance_samples = []
        for record in event_window:
            foot_min, foot_max = sorted((record["left_ankle_x"], record["right_ankle_x"]))
            margin = max((foot_max - foot_min) * .12, .015)
            balance_samples.append(foot_min - margin <= record["hip_x"] <= foot_max + margin)
        wrist_path = [(record[f"{side}_wrist_x"], record[f"{side}_wrist_y"]) for record in event_window]
        wrist_travel = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(wrist_path, wrist_path[1:]))
        event_metrics.append({
            "rotation": (max(shoulders) - min(shoulders)) / max(max(shoulders), .04) * 100,
            "stance": float(np.median([ankle / max(shoulder, .04) for ankle, shoulder in zip(ankles, shoulders)])),
            "balance": sum(balance_samples) / len(balance_samples) * 100,
            "knee": min(record["knee"] for record in event_window),
            "swing": wrist_travel / max(float(np.median(shoulders)), .04),
            "head": (max(record["head_y"] for record in event_window) - min(record["head_y"] for record in event_window)) / max(float(np.median(shoulders)), .04),
        })
    rotation_change = float(np.median([item["rotation"] for item in event_metrics]))
    stance_ratio = float(np.median([item["stance"] for item in event_metrics]))
    balance_rate = float(np.median([item["balance"] for item in event_metrics]))
    knee_angle = float(np.median([item["knee"] for item in event_metrics]))
    swing_travel = float(np.median([item["swing"] for item in event_metrics]))
    head_movement = float(np.median([item["head"] for item in event_metrics]))
    shoulder_widths = [abs(record["right_shoulder_x"] - record["left_shoulder_x"]) for record in window]
    wrist_points = [(record[f"{side}_wrist_x"], record[f"{side}_wrist_y"]) for record in window]

    observations = []
    if rotation_change < 16:
        observations.append((.55, "Limited upper-body rotation", "Rotation range", "Projected shoulder-line change: about %d%%" % round(rotation_change), "From this camera angle, the shoulder line changes very little through the swing window. Build a clearer unit turn during preparation, then let the arm follow the rotation into the swing.", "Shadow swings with a unit-turn pause: 10 reps × 3 sets"))
    else:
        checks.append(check("Rotation range", "good", "Projected shoulder-line change: about %d%%" % round(rotation_change), "The swing window shows a clear change in upper-body rotation."))
    if balance_rate < 72:
        observations.append(((72 - balance_rate) / 55, "Centre of mass moves outside the base of support", "Balance stability", "Hip centre stayed between the feet in about %d%% of movement frames" % round(balance_rate), "In several high-speed frames, the hip centre moves beyond the support area between the feet. Lower your centre of gravity and finish each practice swing in a balanced position for two seconds.", "Swing-and-hold balance drill: 8 reps × 3 sets"))
    else:
        checks.append(check("Balance stability", "good", "Within the base of support: about %d%%" % round(balance_rate), "The hip centre stays within the support area between the feet in most movement frames."))
    if stance_ratio < .72:
        observations.append(((.72 - stance_ratio) / .45, "Narrow stance during the movement window", "Stance width", "Foot spacing: about %.1f times shoulder width" % stance_ratio, "During the high-speed swing window, your feet are closer together than your shoulders. Start near shoulder width and stay mobile with small adjustment steps before the swing.", "Shoulder-width ready stance plus split step: 12 reps × 3 sets"))
    elif stance_ratio > 2.15:
        observations.append(((stance_ratio - 2.15) / 1.3, "Wide stance during the movement window", "Stance width", "Foot spacing: about %.1f times shoulder width" % stance_ratio, "During the high-speed swing window, your feet are more than twice shoulder width apart. Narrow the base by one step and recover immediately after the follow-through.", "Swing followed by a recovery step: 10 reps × 3 sets"))
    else:
        checks.append(check("Stance width", "good", "About %.1f times shoulder width" % stance_ratio, "Stance width remains within a stable comparison range during the movement window."))
    if knee_angle > 158:
        observations.append(((knee_angle - 158) / 22, "Limited lower-body flexion", "Lower-body preparation", "Smallest knee angle in the movement window: about %d°" % round(knee_angle), "Your knees remain relatively straight throughout the swing window. Add a small knee bend during preparation, then extend naturally as the swing moves forward.", "Knee-bend-to-extension shadow swings: 10 reps × 3 sets"))
    else:
        checks.append(check("Lower-body preparation", "good", "Smallest knee angle: about %d°" % round(knee_angle), "Clear lower-body flexion is visible during the movement window."))
    if swing_travel < 1.35:
        observations.append(((1.35 - swing_travel) / 1.0, "Short swing path", "Swing continuity", "Wrist-path length: about %.1f times shoulder width" % swing_travel, "The racket-side wrist travels only a short visible distance during this high-speed movement window. Rehearse the complete path slowly—from preparation through follow-through—before adding speed.", "Slow full-path shadow swings: 8 reps × 3 sets"))
    else:
        checks.append(check("Swing continuity", "good", "Path length: about %.1f times shoulder width" % swing_travel, "The racket-side wrist forms a clear, continuous movement path through the swing window."))
    if head_movement > .62:
        observations.append((min(1.0, (head_movement - .62) / .7), "Large head-height change through the swing", "Posture stability", "Vertical head movement: about %.1f times shoulder width" % head_movement, "Across the clearest swing windows, head height changes sharply. Rehearse staying level through preparation and the forward swing, then allow the finish to lift naturally.", "Level-head shadow swings beside a visual marker: 8 reps × 3 sets"))
    else:
        checks.append(check("Posture stability", "good", "Vertical head movement: about %.1f times shoulder width" % head_movement, "Head height remains comparatively stable across the reviewed swing windows."))

    observations.sort(key=lambda item: item[0], reverse=True)
    selected_observations = observations[:2]
    for observation_index, (_, label, check_label, measured, feedback, exercise) in enumerate(selected_observations):
        checks.append(check(check_label, "warn", measured, feedback))
        suggestions.append(exercise)
        evidence_peak = peaks[min(observation_index, len(peaks) - 1)]
        evidence_window = event_windows[min(observation_index, len(event_windows) - 1)]
        evidence_time = evidence_peak["index"] / fps
        output = evidence_peak["frame"].copy()
        drawing.draw_landmarks(output, evidence_peak["landmarks"], pose_module.POSE_CONNECTIONS)
        height, width = output.shape[:2]
        if check_label == "Rotation range":
            cv2.line(output, (int(evidence_peak["left_shoulder_x"] * width), int(evidence_peak["left_shoulder_y"] * height)), (int(evidence_peak["right_shoulder_x"] * width), int(evidence_peak["right_shoulder_y"] * height)), (55, 76, 235), 4)
        elif check_label in {"Balance stability", "Stance width"}:
            cv2.line(output, (int(evidence_peak["left_ankle_x"] * width), int(evidence_peak["left_ankle_y"] * height)), (int(evidence_peak["right_ankle_x"] * width), int(evidence_peak["right_ankle_y"] * height)), (55, 76, 235), 4)
            cv2.circle(output, (int(evidence_peak["hip_x"] * width), int(evidence_peak["hip_y"] * height)), max(7, width // 90), (91, 240, 217), 3)
        elif check_label == "Swing continuity":
            trail = np.array([(int(record[f"{side}_wrist_x"] * width), int(record[f"{side}_wrist_y"] * height)) for record in evidence_window], dtype=np.int32)
            if len(trail) > 1:
                cv2.polylines(output, [trail], False, (55, 76, 235), 4)
        name = "%s.jpg" % uuid.uuid4().hex
        cv2.imwrite(str(FRAME_DIR / name), output, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
        frames.append({"url": "/data/analysis/%s" % name, "label": label, "checkLabel": check_label, "time": round(evidence_time, 2), "mistake": True})

    if selected_observations:
        labels = ", ".join(item[1].lower() for item in selected_observations)
        overall = "The body-movement path shows %s. The report below explains what is visible and how to improve it." % labels
        goal_title = "Improve %s over the next 4 weeks with three focused movement sessions each week" % selected_observations[0][1].lower()
    else:
        overall = "The body-movement path is stable; no pattern reached the improvement threshold in this analysis."
        suggestions.append("Shadow swing plus recovery step: 10 reps × 3 sets")

    if movement_confidence < 65:
        for item in checks:
            if item["status"] == "good":
                item["status"] = "unknown"
                item["feedback"] = "The visible-frame measurement is within the comparison range, but movement clarity is too low to label it a reliable strength."

    return {
        "analysisVersion": 6, "analysisMode": "multi-window-pose", "movementConfidence": movement_confidence,
        "movement": movement, "movementName": movement_name, "coverage": round(coverage * 100),
        "overall": overall, "checks": checks, "frames": frames,
        "goal": goal_title, "exercises": suggestions,
        "movementMetrics": {"reviewedWindows": len(event_windows), "rotationChange": round(rotation_change), "balanceRate": round(balance_rate), "stanceRatio": round(stance_ratio, 2), "kneeAngle": round(knee_angle), "swingTravel": round(swing_travel, 2), "headMovement": round(head_movement, 2)},
    }
