import type { Stage1Input } from "../../types";
import type { EdgePromptBuilder } from "../types";

/**
 * 定期判定 (periodic) 用の Stage1 エッジプロンプト v2。
 *
 * v1 からの変更:
 *   - 英語主体に (SmolVLM 等の小型 VLM は日本語プロンプトで JSON 遵守が弱い)
 *   - "Output ONLY JSON" を強く繰り返す
 *   - few-shot example を 2 件挿入
 *   - message は日本語で返すよう明示
 */
export const buildPrompt: EdgePromptBuilder = (
  input: Stage1Input,
  options = {},
) => {
  const obs = input.observations.length
    ? input.observations.map((o, i) => `${i + 1}. ${o}`).join("\n")
    : "(none)";
  const next = input.nextStep
    ? `Next step: ${input.nextStep.step_number}. ${input.nextStep.text}`
    : "Next step: (final step)";
  const imgBlock = options.imageContext
    ? ["Image context:", options.imageContext, ""]
    : [];
  return [
    "You are a work assistant. Judge progress from the image and recent observations.",
    "OUTPUT ONLY JSON. No explanation, no markdown, no extra text.",
    "",
    `Current step ${input.currentStep.step_number}: ${input.currentStep.text}`,
    `Visual marker: ${input.currentStep.visual_marker}`,
    next,
    "",
    ...imgBlock,
    "Recent observations:",
    obs,
    "",
    "Decide judgment:",
    "- continue: in progress, no change",
    "- next: current step finished",
    "- anomaly: danger or wrong procedure",
    "Set can_handle=false if unsure or deeper analysis needed.",
    "message must be in Japanese (short).",
    "",
    "## Examples",
    '{"judgment":"continue","confidence":0.8,"message":"","can_handle":true,"escalation_reason":""}',
    '{"judgment":"next","confidence":0.9,"message":"玉ねぎが飴色になりました。次は肉を入れます","can_handle":true,"escalation_reason":""}',
    '{"judgment":"anomaly","confidence":0.6,"message":"焦げ付きそうです、火を弱めて","can_handle":false,"escalation_reason":"異常検知: 焦げ付きの詳細確認と対処提案"}',
    "",
    "Output JSON only:",
    '{"judgment":"continue|next|anomaly","confidence":0.0,"message":"","can_handle":true,"escalation_reason":""}',
  ].join("\n");
};
