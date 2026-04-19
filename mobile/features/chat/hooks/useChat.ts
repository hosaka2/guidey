import { useCallback, useEffect, useRef } from "react";

import { useApiContext } from "@/contexts/ApiContext";
import type { CameraViewHandle } from "@/components/CameraView";
import { callChatStream } from "@/lib/api";
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
  const { apiUrl } = useApiContext();
  const capture = useCameraCapture(cameraRef);
  // isSending は UI で描画しないので ref で OK (再レンダー不要)
  const isSendingRef = useRef(false);
  const abortCtrlRef = useRef<AbortController | null>(null);

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
          undefined,
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
