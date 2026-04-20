import type { EdgePipeline, Stage1Input } from "../types";
import { buildPrompt as periodicV1 } from "./periodic_stage1/v1";
import { buildPrompt as periodicV2 } from "./periodic_stage1/v2";
import { buildPrompt as userActionV1 } from "./user_action_stage1/v1";
import { buildPrompt as userActionV2 } from "./user_action_stage1/v2";
import type { EdgePromptBuilder, EdgePromptOptions } from "./types";

export type { EdgePromptBuilder, EdgePromptOptions } from "./types";

/**
 * エッジ Stage1 のプロンプトを組み立てる dispatcher。
 *
 * pipeline ごとに使う version を固定。差し替えたいときはこのマップを編集する。
 * 新しい v3 を作ったら:
 *   1. `prompts/<pipeline>/v3.ts` を追加
 *   2. 下の BUILDERS に entry 追加
 *   3. CURRENT_VERSIONS をそのキーに書き換え
 *   4. 旧版は残しておく (rollback 可能に)
 *
 * BE 側の backend/src/domain/guide/prompts/ と同じ方針。
 */
const BUILDERS: Record<string, EdgePromptBuilder> = {
  "periodic_stage1/v1": periodicV1,
  "periodic_stage1/v2": periodicV2,
  "user_action_stage1/v1": userActionV1,
  "user_action_stage1/v2": userActionV2,
};

// v2: 小型 VLM (SmolVLM 500M 等) 向けに英語ベース + few-shot で JSON 遵守を強化。
const CURRENT_VERSIONS: Record<EdgePipeline, string> = {
  periodic: "v2",
  user_action: "v2",
};

export function buildEdgePrompt(
  input: Stage1Input,
  options: EdgePromptOptions = {},
): string {
  const pipeline: EdgePipeline = input.pipeline ?? "periodic";
  const version = CURRENT_VERSIONS[pipeline];
  const key = `${pipeline}_stage1/${version}`;
  const builder = BUILDERS[key];
  if (!builder) throw new Error(`edge prompt not found: ${key}`);
  return builder(input, options);
}
