import type { Stage1Input, Stage1Output, Stage1Runner } from "./types";

/**
 * Apple Intelligence Foundation Models を使う runner (スタブ)。
 * 候補: Apple FoundationModels framework (iOS 18+) を Swift Bridge 経由で呼ぶ。
 *   - expo modules (Swift) で Bridge を書く
 *   - Structured Output は Guided Generation API で表現可能
 * 実装時は iOS 限定、Android 側は gemma-local か cloud にフォールバック。
 */
export class AppleFoundationRunner implements Stage1Runner {
  async run(_input: Stage1Input): Promise<Stage1Output | null> {
    throw new Error(
      "[edge-llm/apple-foundation] 未実装。FoundationModels の Swift Bridge を実装する。",
    );
  }
}
