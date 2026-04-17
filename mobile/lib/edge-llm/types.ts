import type { components } from "@/lib/api/schema";

/**
 * Stage1 のエッジ推論用インタフェース。
 * BE の Stage1Output と shape を openapi-typescript で同期し、/periodic の form param
 * `stage1_result` に JSON 化して載せる。BE 側の seed_stage1 ノードがそれを受け取る。
 */

export type Stage1Input = {
  imageBase64: string;
  /** BE と共通のプロンプト文字列 (将来 OpenAPI 経由で拾うことも検討)。 */
  prompt: string;
};

/** BE の Stage1Output と完全一致 (自動生成)。 */
export type Stage1Output = components["schemas"]["Stage1Output"];

export interface Stage1Runner {
  /** 推論実行。null を返すと呼び出し側は従来のクラウド経路にフォールバック。 */
  run(input: Stage1Input): Promise<Stage1Output | null>;
}

export type EdgeMode = "cloud" | "gemma-local" | "apple-foundation";
