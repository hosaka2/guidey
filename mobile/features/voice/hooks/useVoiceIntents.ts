import { useCallback } from "react";
import * as Speech from "expo-speech";

import type { VoiceIntent } from "./useSpeechRecognition";

/**
 * 音声インテントをハンドラ dispatch テーブルに分解する (巨大 switch を排除)。
 * 画面からアクション群 (handlers) を渡し、useSpeechRecognition に流す trigger 関数を返す。
 *
 * 認識キーワードにマッチしない発話は raw を chat に流す (handlers.askChat)。
 */

export type VoiceHandlers = {
  capture?: () => void;
  advanceStep?: () => void;
  goBackStep?: () => void;
  toggleAutonomous?: (wantActive: boolean) => void;
  /** isAutonomous の現在値を取得 (toggle 判定に使う) */
  getIsAutonomous?: () => boolean;
  repeatLast?: () => void;
  askChat?: (text: string) => void;
  sendFeedback?: (sentiment: "positive" | "negative", raw?: string) => void;
  /** 現在 ローディング中 (capture を抑止する) */
  getIsLoading?: () => boolean;
};

export function useVoiceIntents(handlers: VoiceHandlers) {
  return useCallback(
    (action: VoiceIntent, raw?: string) => {
      switch (action) {
        case "capture":
          if (!handlers.getIsLoading?.()) handlers.capture?.();
          break;
        case "next_step":
        case "skip":
          handlers.advanceStep?.();
          break;
        case "previous_step":
          handlers.goBackStep?.();
          break;
        case "stop":
          Speech.stop();
          break;
        case "pause":
          if (handlers.getIsAutonomous?.()) handlers.toggleAutonomous?.(false);
          break;
        case "resume":
          if (!handlers.getIsAutonomous?.()) handlers.toggleAutonomous?.(true);
          break;
        case "repeat":
          handlers.repeatLast?.();
          break;
        case "question":
        case "report_status":
        case "request_help":
          if (!handlers.getIsLoading?.() && raw) handlers.askChat?.(raw);
          break;
        case "feedback_positive":
          handlers.sendFeedback?.("positive", raw);
          break;
        case "feedback_negative":
          handlers.sendFeedback?.("negative", raw);
          break;
        default:
          // キーワード未マッチ: 一定長以上の発話は chat に流す
          if (raw && raw.length >= 4) handlers.askChat?.(raw);
          break;
      }
    },
    [handlers],
  );
}
