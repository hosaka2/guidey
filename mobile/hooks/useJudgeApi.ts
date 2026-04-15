import type { Block } from "@/types/blocks";
import type { JudgeResponse, Plan } from "@/types/plan";
import type { GuideModeType } from "@/constants/Config";

/**
 * プランを取得する.
 */
export async function fetchPlan(
  apiUrl: string,
  sourceId: string
): Promise<Plan> {
  const res = await fetch(`${apiUrl}/guide/plan/${sourceId}`);
  if (!res.ok) {
    throw new Error(`Plan fetch failed: ${res.status}`);
  }
  return res.json();
}

/**
 * 画像を送信して3択判定を取得する.
 */
export async function callJudge(
  apiUrl: string,
  imageUri: string,
  planSourceId: string,
  currentStepIndex: number,
  recentObservations: string[],
  userMessage: string = "",
): Promise<JudgeResponse> {
  const formData = new FormData();

  const filename = imageUri.split("/").pop() ?? "photo.jpg";
  formData.append("file", {
    uri: imageUri,
    name: filename,
    type: "image/jpeg",
  } as unknown as Blob);

  formData.append("plan_source_id", planSourceId);
  formData.append("current_step_index", String(currentStepIndex));
  formData.append("recent_observations", JSON.stringify(recentObservations));
  if (userMessage) {
    formData.append("user_message", userMessage);
  }

  const t0 = Date.now();
  const res = await fetch(`${apiUrl}/guide/judge`, {
    method: "POST",
    body: formData,
  });
  console.log(`[Judge] fetch took ${Date.now() - t0}ms, status=${res.status}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Judge failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  console.log(`[Judge] result: ${json.judgment} (conf=${json.confidence})`);
  return json;
}

/**
 * ユーザー対話 (tool calling + 2段階LLM).
 */
export async function callChat(
  apiUrl: string,
  userMessage: string,
  imageUri: string | null,
  planSourceId: string = "",
  currentStepIndex: number = 0,
  recentObservations: string[] = [],
): Promise<{ message: string; blocks: Block[]; escalated: boolean }> {
  const formData = new FormData();
  formData.append("user_message", userMessage);
  formData.append("plan_source_id", planSourceId);
  formData.append("current_step_index", String(currentStepIndex));
  formData.append("recent_observations", JSON.stringify(recentObservations));

  if (imageUri) {
    const filename = imageUri.split("/").pop() ?? "photo.jpg";
    formData.append("file", {
      uri: imageUri,
      name: filename,
      type: "image/jpeg",
    } as unknown as Blob);
  }

  const t0 = Date.now();
  const res = await fetch(`${apiUrl}/guide/chat`, {
    method: "POST",
    body: formData,
  });
  console.log(`[Chat] fetch took ${Date.now() - t0}ms, status=${res.status}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chat failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  console.log(`[Chat] msg=${json.message?.slice(0, 40)} blocks=${json.blocks?.length} escalated=${json.escalated}`);
  return json;
}

/**
 * ゴールからプランを自動生成する.
 */
export async function generatePlan(
  apiUrl: string,
  goal: string,
  mode: GuideModeType
): Promise<Plan> {
  const t0 = Date.now();
  const res = await fetch(`${apiUrl}/guide/plan/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal, mode }),
  });
  console.log(`[PlanGen] fetch took ${Date.now() - t0}ms, status=${res.status}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Plan generation failed: ${res.status} ${text}`);
  }

  return res.json();
}
