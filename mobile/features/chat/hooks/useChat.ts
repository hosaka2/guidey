import { useCallback, useEffect, useRef } from "react";

import { useApiContext } from "@/contexts/ApiContext";
import type { CameraViewHandle } from "@/components/CameraView";
import { callChatStream } from "@/lib/api";
import {
  getStage1Runner,
  type EdgeStep,
  type Stage1Output,
} from "@/lib/edge-llm";
import { useCameraCapture, type SpeakType } from "@/lib/hooks";
import type { Block, StageEvent } from "@/lib/types";

type Options = {
  cameraRef: React.RefObject<CameraViewHandle | null>;
  sessionId: string;
  /** ブロック表示 (画面の showBlocks) */
  onBlocks: (blocks: Block[]) => void;
  /** TTS 読み上げ */
  onSpeak: (message: string, speakType: SpeakType) => void;
  /** 会話モード切替 (guide.tsx のみで使う。explore は no-op でよい) */
  onEnter?: () => void;
  onExit?: () => void;
  /** チャット前後で lock 取得/解放 (periodic との排他) */
  acquireLock?: () => boolean;
  releaseLock?: () => void;
};

/**
 * ユーザー対話のフック。/chat SSE を叩き、stage イベントごとにブロック追加 + TTS。
 *
 * stage1 escalated は "少し調べますね" の中間通知 (speakType="advise")、
 * stage2 or 非エスカレーション stage1 が本番応答 (speakType="respond")。
 */
export function useChat({
  cameraRef, sessionId, onBlocks, onSpeak,
  onEnter, onExit, acquireLock, releaseLock,
}: Options) {
  const { apiUrl, edgeMode } = useApiContext();
  const capture = useCameraCapture(cameraRef);
  // isSending は UI で描画しないので ref で OK (再レンダー不要)
  const isSendingRef = useRef(false);
  const abortCtrlRef = useRef<AbortController | null>(null);
  const edgeModeRef = useRef(edgeMode);
  edgeModeRef.current = edgeMode;

  // エッジモード選択時はバックグラウンドで context ロード (モデルファイルは既に DL 済前提)。
  // useAutonomousLoop と同じ runner (singleton) を掴むので二重ロードはされない。
  useEffect(() => {
    if (edgeMode === "cloud") return;
    const runner = getStage1Runner(edgeMode);
    if (runner.isReady()) return;
    console.log(`[Chat/edge] preparing ${edgeMode}...`);
    runner.prepare().then(
      () => console.log(`[Chat/edge] ${edgeMode} ready=${runner.isReady()}`),
      (e) => console.warn(`[Chat/edge] ${edgeMode} prepare failed:`, e),
    );
  }, [edgeMode]);

  // 画面 unmount 時に進行中の SSE を強制終了 (guide/explore から戻るケース)
  useEffect(() => {
    return () => {
      abortCtrlRef.current?.abort();
      abortCtrlRef.current = null;
    };
  }, []);

  const sendChat = useCallback(
    async (userMsg: string, withImage = true) => {
      if (isSendingRef.current) return;
      if (!sessionId) {
        console.warn("[Chat] skipped: session not ready");
        return;
      }
      isSendingRef.current = true;
      onEnter?.();
      acquireLock?.();

      // "💬 ユーザー発話" をチャット欄に即表示
      onBlocks([{ type: "text", content: `💬 ${userMsg}`, style: "emphasis" }]);

      const uri = withImage ? await capture() : null;

      // エッジ経路: ユーザー発話 + 画像で on-device stage1 (pipeline=user_action)。
      // can_handle=true ならローカル応答で完結、false なら結果を BE に渡して Stage2。
      let stage1Result: Stage1Output | null = null;
      const mode = edgeModeRef.current;
      if (mode !== "cloud" && uri) {
        const runner = getStage1Runner(mode);
        if (runner.isReady()) {
          try {
            const step: EdgeStep = {
              step_number: 0,
              text: "",
              visual_marker: "",
            };
            stage1Result = await runner.run({
              pipeline: "user_action",
              currentStep: step,
              nextStep: null,
              observations: [],
              imageUri: uri,
              userMessage: userMsg,
            });
            if (stage1Result) {
              console.log(
                `[Chat/edge] j=${stage1Result.judgment} conf=${stage1Result.confidence.toFixed(2)} handle=${stage1Result.can_handle}`,
              );
            }
          } catch (e) {
            console.warn("[Chat/edge] stage1 failed, fallback to cloud:", e);
            stage1Result = null;
          }
        } else {
          console.log(`[Chat/edge] ${mode} not ready, fallback to cloud`);
        }
      }

      // エッジで完結できるなら BE スキップ
      if (stage1Result && stage1Result.can_handle && stage1Result.message) {
        console.log(`[Chat/edge] local-handled`);
        onBlocks([{ type: "text", content: stage1Result.message, style: "normal" }]);
        onSpeak(stage1Result.message, "respond");
        releaseLock?.();
        setTimeout(() => onExit?.(), 3000);
        isSendingRef.current = false;
        return;
      }

      abortCtrlRef.current = new AbortController();
      try {
        await callChatStream(
          apiUrl, userMsg, uri ?? null, sessionId,
          (ev: StageEvent) => {
            const blocks: Block[] = [...(ev.blocks ?? [])];
            if (ev.message) {
              blocks.unshift({ type: "text", content: ev.message, style: "normal" });
            }
            if (blocks.length > 0) onBlocks(blocks);
            if (ev.message) {
              const speakType: SpeakType =
                ev.stage === 1 && ev.escalated ? "advise" : "respond";
              onSpeak(ev.message, speakType);
            }
          },
          stage1Result,
          abortCtrlRef.current.signal,
        );
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          console.log("[Chat] aborted");
        } else {
          console.warn("[Chat] error:", err);
          onBlocks([
            { type: "alert", message: "エラーが発生しました", severity: "warning" },
          ]);
        }
      } finally {
        abortCtrlRef.current = null;
        releaseLock?.();
        // conversation を抜けるまで少し待つ (TTS 完了後)
        setTimeout(() => onExit?.(), 3000);
        isSendingRef.current = false;
      }
    },
    [apiUrl, sessionId, capture,
     onBlocks, onSpeak, onEnter, onExit, acquireLock, releaseLock],
  );

  return { sendChat };
}
