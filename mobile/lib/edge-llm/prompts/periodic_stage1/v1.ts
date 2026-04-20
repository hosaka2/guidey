import type { Stage1Input } from "../../types";
import type { EdgePromptBuilder } from "../types";

/**
 * 定期判定 (periodic) 用の Stage1 エッジプロンプト v1。
 *
 * 役割: カメラ画像 + 直近の観察から「続行 / 次へ / 異常」を判定。
 * BE の backend/src/domain/guide/prompts/periodic_stage1 と役割は同じだが、
 * エッジ LLM (Gemma 4 E2B, n_ctx=2048) 向けに短縮・軽量化している。
 */
export const buildPrompt: EdgePromptBuilder = (
  input: Stage1Input,
  options = {},
) => {
  const obs = input.observations.length
    ? input.observations.map((o, i) => `${i + 1}. ${o}`).join("\n")
    : "(なし)";
  const next = input.nextStep
    ? `次: ${input.nextStep.step_number}. ${input.nextStep.text}`
    : "次: (最終ステップ)";
  const imgBlock = options.imageContext
    ? ["画像から読み取った情報:", options.imageContext, ""]
    : [];
  return [
    "あなたは作業アシスタント。画像と直近の状況から判定する。",
    "",
    `現在のステップ ${input.currentStep.step_number}: ${input.currentStep.text}`,
    `目印: ${input.currentStep.visual_marker}`,
    next,
    "",
    ...imgBlock,
    "直近の状況:",
    obs,
    "",
    "判定ルール:",
    "- continue: 進行中、変化なし",
    "- next: 現在のステップが完了",
    "- anomaly: 異常 (危険、手順逸脱)",
    "自信がない / 深い判断が要るなら can_handle=false にしてエスカレーションする。",
    "",
    '必ず以下の JSON のみで返答する (他のテキスト禁止):',
    '{"judgment":"continue|next|anomaly","confidence":0.0,"message":"","can_handle":true,"escalation_reason":""}',
  ].join("\n");
};
