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

/** どの pipeline の Stage1 を回すか。BE の prompt_loader のキーと対応。 */
export type EdgePipeline = "periodic" | "user_action";

export type Stage1Input = {
  /** periodic | user_action。プロンプト切替に使う (デフォルト periodic)。 */
  pipeline?: EdgePipeline;
  /** 現在のステップ (必須)。 */
  currentStep: EdgeStep;
  /** 次のステップ (任意、最終ステップなら null)。 */
  nextStep: EdgeStep | null;
  /** 直近 observations (BE 側と同じ 3 件上限)。 */
  observations: string[];
  /** カメラ画像の file:// URI (VLM に渡す)。 */
  imageUri: string;
  /** user_action のときのユーザー発話。periodic では空でよい。 */
  userMessage?: string;
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

// エッジプロンプトは ./prompts/ 配下に version 管理つきで分離。
// 公開 API は ./index.ts 経由 (`import { buildEdgePrompt } from "@/lib/edge-llm"`)。
