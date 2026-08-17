importScripts("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.js");

const { FilesetResolver, PoseLandmarker } = Vision;

const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
let poseLandmarker;
let initialization;
let inferenceTimestamp = 0;

async function initialize() {
  if (poseLandmarker) return;
  if (!initialization) {
    initialization = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        numPoses: 4,
        minPoseDetectionConfidence: 0.45,
        minPosePresenceConfidence: 0.45,
        minTrackingConfidence: 0.45
      });
    })();
  }
  await initialization;
}

self.addEventListener("message", async event => {
  const { id, type, bitmap } = event.data;
  try {
    await initialize();
    if (type === "init") {
      self.postMessage({ id, ok: true });
      return;
    }
    if (type !== "detect" || !bitmap) throw new Error("Invalid pose-worker request.");
    inferenceTimestamp += 34;
    const result = poseLandmarker.detectForVideo(bitmap, inferenceTimestamp);
    bitmap.close();
    self.postMessage({
      id,
      ok: true,
      landmarks: result.landmarks || [],
      worldLandmarks: result.worldLandmarks || []
    });
  } catch (error) {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
    self.postMessage({ id, ok: false, error: error?.message || "Pose inference failed." });
  }
});
