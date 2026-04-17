/**
 * SharedState: 定期判定 + ユーザーアクションの共有状態管理.
 *
 * 競合管理:
 * - isBusy: 同時実行防止 (judge中はchat待機、chat中はjudge待機)
 * - isSpeaking: TTS競合防止 (warn以外は先着優先)
 * - mode: 会話モード中は定期判定の発話抑制
 */

import { useCallback, useRef } from "react";
import * as Speech from "expo-speech";

import type { Block } from "@/lib/types";

export type AgentMode = "autonomous" | "conversing";

export type SpeakType = "transition" | "warn" | "encourage" | "advise" | "respond";

type ApplyResultParams = {
  message: string;
  blocks: Block[];
  source: "periodic" | "user_action";
  speakType?: SpeakType;
  /** 発話とブロック表示のコールバック (guide.tsx から注入) */
  onSpeak?: (message: string) => void;
  onBlocks?: (blocks: Block[]) => void;
};

export function useAgentState() {
  // mode は外部から描画されない (speak の判定にしか使わない) → ref で OK
  const modeRef = useRef<AgentMode>("autonomous");

  // --- 競合管理フラグ ---
  const isBusyRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const currentSpeakSourceRef = useRef<"periodic" | "user_action" | null>(null);

  // --- TTS管理 ---
  const pauseCallbackRef = useRef<(() => void) | null>(null);
  const resumeCallbackRef = useRef<(() => void) | null>(null);

  /** TTS pause/resume コールバックを登録 (音声認識との連携) */
  const registerTTSCallbacks = useCallback(
    (pause: () => void, resume: () => void) => {
      pauseCallbackRef.current = pause;
      resumeCallbackRef.current = resume;
    },
    []
  );

  /** ロック取得 (同時実行防止) */
  const acquireLock = useCallback((): boolean => {
    if (isBusyRef.current) return false;
    isBusyRef.current = true;
    return true;
  }, []);

  /** ロック解放 */
  const releaseLock = useCallback(() => {
    isBusyRef.current = false;
  }, []);

  /** TTS発話 (競合防止付き) */
  const speak = useCallback(
    (
      message: string,
      source: "periodic" | "user_action",
      speakType: SpeakType = "respond"
    ): boolean => {
      if (!message) return false;

      // 会話モード中は定期判定の発話を抑制 (warn 除く)
      if (
        modeRef.current === "conversing" &&
        source === "periodic" &&
        speakType !== "warn"
      ) {
        return false;
      }

      // 既に発話中: warn は割り込み可、それ以外はスキップ
      if (isSpeakingRef.current) {
        if (speakType === "warn") {
          Speech.stop(); // 現在の発話を中断
        } else {
          return false;
        }
      }

      isSpeakingRef.current = true;
      currentSpeakSourceRef.current = source;

      // 音声認識を一時停止
      pauseCallbackRef.current?.();

      Speech.speak(message, {
        language: "ja",
        rate: 1.1,
        onDone: () => {
          isSpeakingRef.current = false;
          currentSpeakSourceRef.current = null;
          resumeCallbackRef.current?.();
        },
        onStopped: () => {
          isSpeakingRef.current = false;
          currentSpeakSourceRef.current = null;
          resumeCallbackRef.current?.();
        },
        onError: () => {
          isSpeakingRef.current = false;
          currentSpeakSourceRef.current = null;
          resumeCallbackRef.current?.();
        },
      });
      return true;
    },
    [],
  );

  /** 結果適用 (両ループ共通) */
  const applyResult = useCallback(
    ({
      message,
      blocks,
      source,
      speakType = "respond",
      onSpeak,
      onBlocks,
    }: ApplyResultParams) => {
      // ブロック表示
      if (blocks.length > 0) {
        onBlocks?.(blocks);
      }

      // 発話
      if (message) {
        const spoken = speak(message, source, speakType);
        if (spoken) {
          onSpeak?.(message);
        }
      }
    },
    [speak]
  );

  /** 会話モード切替 (ユーザー発話検知時) */
  const enterConversation = useCallback(() => {
    modeRef.current = "conversing";
    // 定期判定の発話を中断
    if (currentSpeakSourceRef.current === "periodic") {
      Speech.stop();
    }
  }, []);

  /** 自律モードに復帰 (会話終了後) */
  const exitConversation = useCallback(() => {
    modeRef.current = "autonomous";
  }, []);

  return {
    isBusyRef,
    isSpeakingRef,
    acquireLock,
    releaseLock,
    speak,
    applyResult,
    registerTTSCallbacks,
    enterConversation,
    exitConversation,
  };
}
