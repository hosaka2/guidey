import type { Stage1Input } from "../../types";
import type { EdgePromptBuilder } from "../types";

/**
 * ユーザー対話 (user_action) 用の Stage1 エッジプロンプト v1。
 *
 * 役割: ユーザーの発話に対して「即答できるか / Stage2 へのエスカレーション予告か」を判定。
 * BE の backend/src/domain/guide/prompts/user_action_stage1 と同じ方針だが、
 * エッジ LLM (Gemma 4 E2B, n_ctx=2048) 向けに短縮している。
 */
export const buildPrompt: EdgePromptBuilder = (
  input: Stage1Input,
  options = {},
) => {
  const obs = input.observations.length
    ? input.observations.map((o, i) => `${i + 1}. ${o}`).join("\n")
    : "(なし)";
  const stepLine = input.currentStep.text
    ? `現在のステップ ${input.currentStep.step_number}: ${input.currentStep.text}`
    : "";
  const imgBlock = options.imageContext
    ? ["画像から読み取った情報:", options.imageContext, ""]
    : [];
  return [
    "ユーザー発話に応答する。自分で答えられるなら即答、無理ならエスカレーション予告。",
    "",
    stepLine,
    "",
    ...imgBlock,
    "直近の状況:",
    obs,
    "",
    `ユーザー: 「${input.userMessage ?? ""}」`,
    "",
    "方針:",
    "- 簡単な質問/励まし/聞き返し → can_handle=true で message に回答",
    "- 画像/タイマー/検索/調査/プラン変更が必要 → can_handle=false + 短い予告 (「少々お待ちください」等)",
    "- can_handle=false のとき escalation_reason に Stage2 が何をすべきか具体的に書く",
    "",
    "judgment はユーザー発話ベースなので基本 continue。明確に次へ/異常なら next/anomaly。",
    "",
    '必ず以下の JSON のみで返答する (他のテキスト禁止):',
    '{"judgment":"continue|next|anomaly","confidence":0.0,"message":"","can_handle":true,"escalation_reason":""}',
  ].join("\n");
};
