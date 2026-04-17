import type { Stage1Output } from "@/lib/edge-llm";
import type { StageEvent } from "@/lib/types";
import { attachFile } from "./client";
import { streamSSE } from "./stream";

/** ユーザー対話 /chat SSE。画像は任意、session_id なしは BE 側で ephemeral seed。 */
export async function callChatStream(
  apiUrl: string,
  userMessage: string,
  imageUri: string | null,
  sessionId: string,
  onEvent: (ev: StageEvent) => void,
  stage1Result?: Stage1Output | null,
): Promise<void> {
  const form = new FormData();
  form.append("user_message", userMessage);
  form.append("session_id", sessionId);
  if (imageUri) attachFile(form, imageUri);
  if (stage1Result) form.append("stage1_result", JSON.stringify(stage1Result));
  return streamSSE(`${apiUrl}/guide/chat`, form, onEvent, "Chat");
}
