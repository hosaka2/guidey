import { AppleFoundationRunner } from "./apple-foundation";
import { CloudStage1Runner } from "./cloud";
import { GemmaLocalRunner } from "./gemma-local";
import type { EdgeMode, Stage1Runner } from "./types";

export type { EdgeMode, Stage1Input, Stage1Output, Stage1Runner } from "./types";

/**
 * 設定されたエッジモードに応じた Stage1 ランナーを返す。
 * cloud が既定 (run() は null を返す = BE が stage1 を実行)。
 * gemma-local / apple-foundation は将来実装。
 */
export function getStage1Runner(mode: EdgeMode): Stage1Runner {
  switch (mode) {
    case "gemma-local":
      return new GemmaLocalRunner();
    case "apple-foundation":
      return new AppleFoundationRunner();
    case "cloud":
    default:
      return new CloudStage1Runner();
  }
}
