import type { components } from "@/lib/api/schema";

/**
 * Stage1 のエッジ推論用インタフェース。
 * BE の Stage1Output と shape を openapi-typescript で同期し、/periodic の form param
 * `stage1_result` に JSON 化して載せる。BE 側の seed_stage1 ノードがそれを受け取る。
 */

export type EdgeStep = {
  step_number: number;
  text: string;
  visual_marker: string;
};

export type Stage1Input = {
  /** 現在のステップ (必須)。 */
  currentStep: EdgeStep;
  /** 次のステップ (任意、最終ステップなら null)。 */
  nextStep: EdgeStep | null;
  /** 直近 observations (BE 側と同じ 3 件上限)。 */
  observations: string[];
  /** カメラ画像の file:// URI (VLM に渡す)。 */
  imageUri: string;
};

/** BE の Stage1Output と完全一致 (自動生成)。 */
export type Stage1Output = components["schemas"]["Stage1Output"];

export interface Stage1Runner {
  /** 推論実行。null を返すと呼び出し側は従来のクラウド経路にフォールバック。 */
  run(input: Stage1Input): Promise<Stage1Output | null>;
  /** 初期化状態を返す (モデル ready か)。false なら run() 呼び出しはスキップ推奨。 */
  isReady(): boolean;
  /** モデルロード (必要なら)。冪等。 */
  prepare(): Promise<void>;
  /** リソース解放 (Settings で切替時に呼ぶ)。 */
  dispose(): Promise<void>;
}

export type EdgeMode = "cloud" | "gemma-local";

/** エッジ専用の短縮プロンプトを組み立てる (全ランナー共通)。
 *
 * `imageContext` が入るのは、画像を直接扱えない runner (Apple) が Vision framework で
 * 抽出したキャプション/OCR 結果をここに挿す想定。VLM 直接入力できる runner (Gemma) は空で良い。
 */
export function buildEdgePrompt(
  input: Stage1Input,
  options: { imageContext?: string } = {},
): string {
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
}
