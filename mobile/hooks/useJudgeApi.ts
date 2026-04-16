import type { Block } from "@/types/blocks";
import type { JudgeResponse, Plan } from "@/types/plan";

/**
 * プランを取得する (session_id がレスポンスに含まれる).
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
 * 画像を送信して3択判定を取得する. session_id + image のみ.
 */
export async function callJudge(
  apiUrl: string,
  imageUri: string,
  sessionId: string,
): Promise<JudgeResponse> {
  const formData = new FormData();

  const filename = imageUri.split("/").pop() ?? "photo.jpg";
  formData.append("file", {
    uri: imageUri,
    name: filename,
    type: "image/jpeg",
  } as unknown as Blob);

  formData.append("session_id", sessionId);

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
 * ユーザー対話. session_id + message (+ image) のみ.
 */
export async function callChat(
  apiUrl: string,
  userMessage: string,
  imageUri: string | null,
  sessionId: string = "",
): Promise<{ message: string; blocks: Block[]; escalated: boolean }> {
  const formData = new FormData();
  formData.append("user_message", userMessage);
  formData.append("session_id", sessionId);

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
 * ゴールからプランを自動生成する (session_id がレスポンスに含まれる).
 */
/**
 * ゴールからプランを自動生成する (session_id がレスポンスに含まれる).
 */
export async function generatePlan(
  apiUrl: string,
  goal: string,
): Promise<Plan> {
  const t0 = Date.now();
  const res = await fetch(`${apiUrl}/guide/plan/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  console.log(`[PlanGen] fetch took ${Date.now() - t0}ms, status=${res.status}`);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Plan generation failed: ${res.status} ${text}`);
  }

  return res.json();
}

/**
 * 探索モード用セッション開始 (プランなし).
 */
export async function startSession(
  apiUrl: string,
): Promise<{ session_id: string }> {
  const res = await fetch(`${apiUrl}/guide/session/start`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Session start failed: ${res.status}`);
  }
  return res.json();
}
