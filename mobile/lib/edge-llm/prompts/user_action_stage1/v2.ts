import type { Stage1Input } from "../../types";
import type { EdgePromptBuilder } from "../types";

/**
 * ユーザー対話 (user_action) 用の Stage1 エッジプロンプト v2。
 *
 * v1 からの変更:
 *   - 英語主体に (SmolVLM 等の小型 VLM は日本語プロンプトで JSON 遵守が弱い)
 *   - "Output ONLY JSON" を強く繰り返す
 *   - few-shot example を 2 件挿入
 *   - 応答は日本語で返すよう明示 (JSON の message フィールドだけ日本語)
 */
export const buildPrompt: EdgePromptBuilder = (
  input: Stage1Input,
  options = {},
) => {
  const obs = input.observations.length
    ? input.observations.map((o, i) => `${i + 1}. ${o}`).join("\n")
    : "(none)";
  const stepLine = input.currentStep.text
    ? `Current step ${input.currentStep.step_number}: ${input.currentStep.text}`
    : "No active step.";
  const imgBlock = options.imageContext
    ? ["Image context:", options.imageContext, ""]
    : [];
  return [
    "You are a work assistant. Respond to the user's utterance.",
    "OUTPUT ONLY JSON. No explanation, no markdown, no extra text.",
    "",
    stepLine,
    "",
    ...imgBlock,
    "Recent observations:",
    obs,
    "",
    `User: "${input.userMessage ?? ""}"`,
    "",
    "Decide:",
    "- Simple answer / encouragement / clarification question -> can_handle=true, message in Japanese",
    "- Need tools (image, timer, search, plan change) -> can_handle=false, short preview message in Japanese (e.g. '少々お待ちください'), escalation_reason in Japanese describing what Stage2 should do",
    "- judgment = continue (default), next only if user clearly advanced, anomaly only if emergency",
    "",
    "## Examples",
    '{"judgment":"continue","confidence":0.8,"message":"はい、きれいにできています","can_handle":true,"escalation_reason":""}',
    '{"judgment":"continue","confidence":0.7,"message":"セットします","can_handle":false,"escalation_reason":"タイマー180秒を「煮込み」でセット"}',
    '{"judgment":"continue","confidence":0.6,"message":"何分のタイマーにしますか?","can_handle":true,"escalation_reason":""}',
    "",
    "Output JSON only:",
    '{"judgment":"continue|next|anomaly","confidence":0.0,"message":"","can_handle":true,"escalation_reason":""}',
  ].join("\n");
};
