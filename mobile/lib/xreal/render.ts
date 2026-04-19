import type { Block } from "@/lib/types";

import { unityBridge } from "./bridge";

const GO = "RenderBridge";

/**
 * XREAL グラスの空間 UI (Unity World Space Canvas) にブロックを描画する。
 *
 * RN 側で管理している activeBlocks をそのまま Unity に送り、
 * Unity 側 (RenderBridge.cs) が text / image / alert / timer を 3D 空間に描画する。
 *
 * unity bridge 未起動 (非 Android / Unity 未統合ビルド) では fire-and-forget で no-op。
 */
export async function showBlocksOnGlasses(blocks: Block[]): Promise<void> {
  if (!unityBridge.isStarted()) return;
  try {
    await unityBridge.send({
      gameObject: GO,
      method: "ShowBlocks",
      args: { blocks },
      timeoutMs: 2000,
    });
  } catch (e) {
    if (__DEV__) console.warn("[xreal/render] showBlocks failed:", e);
  }
}

/** グラス上のブロックをすべて消す。画面遷移時などで呼ぶ。 */
export async function clearBlocksOnGlasses(): Promise<void> {
  if (!unityBridge.isStarted()) return;
  try {
    await unityBridge.send({
      gameObject: GO,
      method: "ClearBlocks",
      timeoutMs: 2000,
    });
  } catch (e) {
    if (__DEV__) console.warn("[xreal/render] clearBlocks failed:", e);
  }
}
