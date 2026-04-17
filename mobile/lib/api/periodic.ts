import type { Stage1Output } from "@/lib/edge-llm";
import type { StageEvent } from "@/lib/types";
import { attachFile } from "./client";
import { streamSSE } from "./stream";

/**
 * 定期監視 /periodic SSE。stage1 → (stage2) を順次 emit。
 * `stage1Result` を渡すと BE の seed_stage1 経由 (エッジ推論結果の持ち込み)。
 */
export async function callPeriodicStream(
  apiUrl: string,
  imageUri: string,
  sessionId: string,
  onEvent: (ev: StageEvent) => void,
  stage1Result?: Stage1Output | null,
): Promise<void> {
  const form = new FormData();
  attachFile(form, imageUri);
  form.append("session_id", sessionId);
  if (stage1Result) {
    form.append("stage1_result", JSON.stringify(stage1Result));
  }
  return streamSSE(`${apiUrl}/guide/periodic`, form, onEvent, "Periodic");
}
