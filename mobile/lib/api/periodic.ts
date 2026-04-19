import type { Stage1Output } from "@/lib/edge-llm";
import type { StageEvent } from "@/lib/types";
import { attachFile, postJson } from "./client";
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
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData();
  attachFile(form, imageUri);
  form.append("session_id", sessionId);
  if (stage1Result) {
    form.append("stage1_result", JSON.stringify(stage1Result));
  }
  return streamSSE(`${apiUrl}/guide/periodic`, form, onEvent, "Periodic", signal);
}

export type PeriodicSyncResponse = {
  current_step_index: number;
  recent_observations: string[];
  total_steps: number;
};

/**
 * エッジ LLM 経路の state 同期 (画像なし、LLM 呼び出しなし).
 * モバイル側で進めた current_step_index と集めた observations を BE に反映する。
 */
export async function callPeriodicSync(
  apiUrl: string,
  sessionId: string,
  currentStepIndex: number | null,
  newObservations: string[],
): Promise<PeriodicSyncResponse> {
  return postJson<PeriodicSyncResponse>(`${apiUrl}/guide/periodic/sync`, {
    session_id: sessionId,
    current_step_index: currentStepIndex,
    new_observations: newObservations,
  });
}
