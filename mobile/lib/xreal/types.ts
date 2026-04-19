/**
 * XREAL Unity bridge の JSON プロトコル。
 * Unity 側 (CameraBridge.cs 他) と型を合わせて保持する。
 */

/** RN → Unity (postMessage の payload JSON)。 */
export type UnityRequest = {
  /** 相関 ID (UUID)。レスポンスと紐づける。 */
  id: string;
  /** method 名 (Unity GameObject 側のメソッド名と対応)。 */
  method: string;
  /** 任意の追加引数。method ごとに型が決まる。 */
  args?: Record<string, unknown>;
};

/** Unity → RN (onUnityMessage で届く JSON)。 */
export type UnityResponse = {
  id: string;
  /** どの bridge 由来か (camera / spatial / render ...)。 */
  kind: "camera" | "spatial" | "render" | "system";
  /** 成功時、kind 別のデータ (JSON 文字列) or 直接 object。 */
  data?: string | Record<string, unknown> | null;
  /** 失敗時のメッセージ (非空ならエラー扱い)。 */
  error?: string | null;
};

// ============================================================================
// Camera 系
// ============================================================================

export type CameraCaptureResult = {
  /** file:// URI (Unity 側 temporaryCachePath)。 */
  uri: string;
};

export type CameraReadyResult = {
  ready: boolean;
  /** ready=false の時の原因 (glasses not connected 等)。 */
  reason?: string | null;
};
