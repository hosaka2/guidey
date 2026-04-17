import type { Stage1Input, Stage1Output, Stage1Runner } from "./types";

/**
 * Gemma をオンデバイスでホストして推論する runner (スタブ)。
 * 候補ライブラリ: llama.rn / react-native-mlc-llm / @mlc-ai/web-llm (WebView 経由) など。
 * 実装時は:
 *   1. モデル重みを初回ダウンロード (アプリ起動時)
 *   2. inferJSON(prompt, imageBytes) で Stage1Output JSON を取得
 *   3. JSON.parse → Stage1Output 形式に整える
 */
export class GemmaLocalRunner implements Stage1Runner {
  async run(_input: Stage1Input): Promise<Stage1Output | null> {
    throw new Error(
      "[edge-llm/gemma-local] 未実装。llama.rn 等でモデルをロードして実装する。",
    );
  }
}
