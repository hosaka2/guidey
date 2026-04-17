import { useCallback } from "react";

import { useApiContext } from "@/contexts/ApiContext";
import { submitFeedback } from "@/lib/api";

type Options = {
  /** 発話/操作のコンテキスト: 指示文の先頭など */
  getTargetContent: () => string;
  /** 現在のステップ (任意) */
  getStepIndex?: () => number | null;
};

/**
 * 画面から 1 行で発話フィードバックを送るフック。
 * target_type: "utterance" 固定。必要に応じて将来拡張。
 */
export function useFeedback(opts: Options) {
  const { apiUrl } = useApiContext();

  return useCallback(
    (sentiment: "positive" | "negative" | "neutral", source: string, raw?: string) => {
      submitFeedback(apiUrl, {
        target_type: "utterance",
        sentiment,
        source,
        target_content: opts.getTargetContent().slice(0, 100),
        raw_content: raw ?? "",
        step_index: opts.getStepIndex?.() ?? null,
      });
    },
    [apiUrl, opts],
  );
}
