import { unityBridge } from "./bridge";
import type { CameraCaptureResult, CameraReadyResult } from "./types";

const GO = "CameraBridge";

/**
 * XREAL Eye カメラから 1 フレーム取得。
 * 成功時は file:// URI、bridge 未起動 / SDK 未初期化 / タイムアウト時は null。
 */
export async function captureXrealFrame(): Promise<string | null> {
  if (!unityBridge.isStarted()) {
    console.warn("[xreal] unity bridge not started → null");
    return null;
  }
  try {
    const res = await unityBridge.send<CameraCaptureResult>({
      gameObject: GO,
      method: "Capture",
      timeoutMs: 3000,
    });
    return res?.uri ?? null;
  } catch (e) {
    console.warn("[xreal] capture failed:", e);
    // デバッグ補助: 失敗時に IsReady を投げて SDK 側に reason ログを吐かせる
    // (fire-and-forget。logcat で原因追跡できるように)
    void isXrealCameraReady().catch(() => {});
    return null;
  }
}

/** SDK 初期化済みか問い合わせ。ready=false のとき reason が logcat に出る。 */
export async function isXrealCameraReady(): Promise<boolean> {
  if (!unityBridge.isStarted()) {
    console.warn("[xreal] IsReady: unity bridge not started");
    return false;
  }
  try {
    const res = await unityBridge.send<CameraReadyResult>({
      gameObject: GO,
      method: "IsReady",
      timeoutMs: 2000,
    });
    if (!res?.ready) {
      console.warn("[xreal] IsReady=false reason:", res?.reason ?? "(no reason)");
    } else {
      console.log("[xreal] IsReady=true");
    }
    return !!res?.ready;
  } catch (e) {
    console.warn("[xreal] IsReady failed:", e);
    return false;
  }
}
