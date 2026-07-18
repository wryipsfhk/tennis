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
        raise ValueError("无法读取这个视频，请上传 MP4、MOV 或 WebM 文件。")
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if frame_count < 8:
        capture.release()
        raise ValueError("视频太短，请上传一段完整比赛视频。")
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
        raise ValueError("无法读取视频画面。")
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
        vertical = "近端" if y + h / 2 > height / 2 else "远端"
        horizontal = "左侧" if x + w / 2 < width / 2 else "右侧"
        candidates.append({
            "id": str(index + 1), "label": "画面中的主要球员" if used_fallback else "%s%s球员" % (vertical, horizontal),
            "thumbnail": "/data/analysis/%s" % name,
            "bbox": [x / width, y / height, w / width, h / height],
        })
    return candidates


def analyze_video(video_path, movement="match", player_bbox=None, forced_contact_time=None):
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError("无法读取这个视频，请上传 MP4、MOV 或 WebM 文件。")
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    if frame_count < 8:
        capture.release()
        raise ValueError("视频太短，无法识别完整动作。请上传包含准备到随挥的片段。")
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
        raise ValueError("没有稳定识别到完整身体。请使用全身入镜、光线充足且镜头固定的视频。")

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
    peak = max(records, key=lambda record: record[f"{side}_speed"])
    peak_time = peak["index"] / fps
    window = [record for record in records if abs(record["index"] - peak["index"]) / fps <= .85]
    if len(window) < 4:
        window = sorted(records, key=lambda record: abs(record["index"] - peak["index"]))[:6]
        window.sort(key=lambda record: record["index"])

    pose_quality = float(np.mean([record["pose_quality"] for record in window]))
    high_speed = speed_percentiles[side]["high"]
    median_speed = speed_percentiles[side]["median"]
    motion_signal = min(1.0, max(0.0, (high_speed - median_speed) / max(high_speed, .04) * 1.35))
    movement_confidence = min(96, round(100 * (.55 * min(1.0, coverage) + .30 * pose_quality + .15 * motion_signal)))
    movement_name = "整场比赛 · 动作轨迹"
    checks, frames, suggestions = [], [], []
    goal_title = "未来 4 周提升动作稳定性：每周完成 3 次脚步、平衡与挥拍连贯训练"

    if movement_confidence < 45:
        checks.append(check("身体动作轨迹", "unknown", "动作轨迹清晰度 %d%%" % movement_confidence, "画面中的身体关键点不够连续，本次不判断技术问题。建议固定机位并让球员在画面中更大、更清楚。"))
        return {
            "analysisVersion": 4, "analysisMode": "pose-only", "movementConfidence": movement_confidence,
            "movement": movement, "movementName": movement_name, "coverage": round(coverage * 100),
            "overall": "身体动作轨迹不够清楚，本次不生成技术判断。", "checks": checks, "frames": [],
            "goal": goal_title, "exercises": [],
        }

    shoulder_widths = [abs(record["right_shoulder_x"] - record["left_shoulder_x"]) for record in window]
    ankle_widths = [abs(record["right_ankle_x"] - record["left_ankle_x"]) for record in window]
    rotation_change = (max(shoulder_widths) - min(shoulder_widths)) / max(max(shoulder_widths), .04) * 100
    stance_ratio = float(np.median([ankle / max(shoulder, .04) for ankle, shoulder in zip(ankle_widths, shoulder_widths)]))
    balance_samples = []
    for record in window:
        foot_min, foot_max = sorted((record["left_ankle_x"], record["right_ankle_x"]))
        margin = max((foot_max - foot_min) * .12, .015)
        balance_samples.append(foot_min - margin <= record["hip_x"] <= foot_max + margin)
    balance_rate = sum(balance_samples) / len(balance_samples) * 100
    knee_angle = min(record["knee"] for record in window)
    wrist_points = [(record[f"{side}_wrist_x"], record[f"{side}_wrist_y"]) for record in window]
    wrist_travel = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(wrist_points, wrist_points[1:]))
    median_shoulder = max(float(np.median(shoulder_widths)), .04)
    swing_travel = wrist_travel / median_shoulder

    observations = []
    if rotation_change < 16:
        observations.append((.55, "上半身转动变化较小", "转体幅度", "动作窗口内肩线宽度变化约 %d%%" % round(rotation_change), "从这个机位看，挥拍前后肩线的投影变化较小。这可能表示上半身准备和释放不够明显；可以尝试先完成肩髋转动，再让手臂跟随。", "影子挥拍：转肩停顿后完成挥拍 10 次 × 3 组"))
    else:
        checks.append(check("转体幅度", "good", "肩线投影变化约 %d%%" % round(rotation_change), "画面中能看到挥拍窗口内较清楚的上半身转动变化。"))
    if balance_rate < 72:
        observations.append(((72 - balance_rate) / 55, "挥拍过程重心偏出支撑范围", "平衡稳定性", "约 %d%% 的动作帧中髋部中心位于双脚支撑范围内" % round(balance_rate), "在部分高速动作帧中，髋部中心移到双脚支撑范围之外。这可能影响击球后的恢复；可以降低重心，并在挥拍结束后保持两秒稳定。", "挥拍定格平衡 8 次 × 3 组"))
    else:
        checks.append(check("平衡稳定性", "good", "支撑范围内比例约 %d%%" % round(balance_rate), "大部分动作帧中，髋部中心保持在双脚支撑范围内。"))
    if stance_ratio < .72:
        observations.append(((.72 - stance_ratio) / .45, "动作窗口内站位偏窄", "站位宽度", "双脚宽度约为肩宽的 %.1f 倍" % stance_ratio, "从这个机位看，高速挥拍阶段双脚距离较窄。这可能减少横向稳定性；可以把准备站位调整到接近肩宽，并用小碎步保持可移动状态。", "肩宽准备站位 + 分腿垫步 12 次 × 3 组"))
    elif stance_ratio > 2.15:
        observations.append(((stance_ratio - 2.15) / 1.3, "动作窗口内站位偏宽", "站位宽度", "双脚宽度约为肩宽的 %.1f 倍" % stance_ratio, "从这个机位看，高速挥拍阶段站位较宽。这可能限制下一步移动；可以缩小一步，并在挥拍后立即做恢复步。", "挥拍后恢复步 10 次 × 3 组"))
    else:
        checks.append(check("站位宽度", "good", "约为肩宽的 %.1f 倍" % stance_ratio, "动作窗口内的站位宽度处于较稳定的范围。"))
    if knee_angle > 158:
        observations.append(((knee_angle - 158) / 22, "下肢屈曲较少", "下肢准备", "动作窗口内最小膝角约 %d°" % round(knee_angle), "从画面看，挥拍窗口内膝关节保持得较直。这可能减少向上和向前的发力空间；可以在准备阶段轻微屈膝，再自然伸展。", "屈膝—伸展影子挥拍 10 次 × 3 组"))
    else:
        checks.append(check("下肢准备", "good", "最小膝角约 %d°" % round(knee_angle), "动作窗口内能看到明确的下肢屈曲。"))
    if swing_travel < 1.35:
        observations.append(((1.35 - swing_travel) / 1.0, "挥拍轨迹较短", "挥拍连贯性", "手腕轨迹长度约为肩宽的 %.1f 倍" % swing_travel, "这个高速动作窗口内，持拍手的可见移动距离较短。这可能是紧张或准备较晚；可以先用慢速完整挥拍练习连贯轨迹，再逐渐加速。", "慢速完整挥拍 8 次 × 3 组"))
    else:
        checks.append(check("挥拍连贯性", "good", "轨迹长度约为肩宽的 %.1f 倍" % swing_travel, "持拍手在动作窗口内形成了清楚、连续的移动轨迹。"))

    observations.sort(key=lambda item: item[0], reverse=True)
    selected_observations = observations[:2]
    for _, label, check_label, measured, feedback, exercise in selected_observations:
        checks.append(check(check_label, "warn", measured, feedback))
        suggestions.append(exercise)
        output = peak["frame"].copy()
        drawing.draw_landmarks(output, peak["landmarks"], pose_module.POSE_CONNECTIONS)
        height, width = output.shape[:2]
        if check_label == "转体幅度":
            cv2.line(output, (int(peak["left_shoulder_x"] * width), int(peak["left_shoulder_y"] * height)), (int(peak["right_shoulder_x"] * width), int(peak["right_shoulder_y"] * height)), (55, 76, 235), 4)
        elif check_label in {"平衡稳定性", "站位宽度"}:
            cv2.line(output, (int(peak["left_ankle_x"] * width), int(peak["left_ankle_y"] * height)), (int(peak["right_ankle_x"] * width), int(peak["right_ankle_y"] * height)), (55, 76, 235), 4)
            cv2.circle(output, (int(peak["hip_x"] * width), int(peak["hip_y"] * height)), max(7, width // 90), (91, 240, 217), 3)
        elif check_label == "挥拍连贯性":
            trail = np.array([(int(x * width), int(y * height)) for x, y in wrist_points], dtype=np.int32)
            if len(trail) > 1:
                cv2.polylines(output, [trail], False, (55, 76, 235), 4)
        name = "%s.jpg" % uuid.uuid4().hex
        cv2.imwrite(str(FRAME_DIR / name), output, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
        frames.append({"url": "/data/analysis/%s" % name, "label": label, "checkLabel": check_label, "time": round(peak_time, 2), "mistake": True})

    if selected_observations:
        labels = "、".join(item[1] for item in selected_observations)
        overall = "从身体动作轨迹中观察到：%s。以下是可能的改进方向。" % labels
        goal_title = "未来 4 周改善%s：每周完成 3 次针对性动作训练" % selected_observations[0][1]
    else:
        overall = "身体动作轨迹较稳定，本次没有观察到达到提示阈值的明显模式。"
        suggestions.append("影子挥拍与恢复步组合 10 次 × 3 组")

    if movement_confidence < 65:
        for item in checks:
            if item["status"] == "good":
                item["status"] = "unknown"
                item["feedback"] = "可见帧中的数值处于比较范围内，但动作轨迹清晰度不足，暂不把它标记为稳定优势。"

    return {
        "analysisVersion": 4, "analysisMode": "pose-only", "movementConfidence": movement_confidence,
        "movement": movement, "movementName": movement_name, "coverage": round(coverage * 100),
        "overall": overall, "checks": checks, "frames": frames,
        "goal": goal_title, "exercises": suggestions,
        "movementMetrics": {"rotationChange": round(rotation_change), "balanceRate": round(balance_rate), "stanceRatio": round(stance_ratio, 2), "kneeAngle": round(knee_angle), "swingTravel": round(swing_travel, 2)},
    }
