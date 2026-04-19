import { useCallback } from "react";

import type { CameraViewHandle } from "@/components/CameraView";
import { useApiContext } from "@/contexts/ApiContext";
import { captureXrealFrame } from "@/lib/xreal";

/**
 * カメラソース抽象。periodic / chat / calibration の撮影系はこの関数を経由する。
 *
 * - `phone-back`: 既存 `CameraView` の takePicture (forwardRef 経由)
 * - `xreal-eye` : Unity アダプタ (XREAL SDK) 経由のフレーム取得
 *                 Unity 未マウント / SDK 未初期化 / タイムアウト時は phone-back にフォールバック
 */
export function useCameraCapture(cameraRef: React.RefObject<CameraViewHandle | null>) {
  const { cameraSource } = useApiContext();

  return useCallback(async (): Promise<string | null> => {
    if (cameraSource === "xreal-eye") {
      const uri = await captureXrealFrame();
      if (uri) return uri;
      console.warn("[camera] xreal-eye failed → phone-back fallback");
    }
    return (await cameraRef.current?.takePicture()) ?? null;
  }, [cameraSource, cameraRef]);
}
