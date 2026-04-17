import { useCallback, useRef } from "react";

import { useApiContext } from "@/contexts/ApiContext";
import type { CameraViewHandle } from "@/components/CameraView";
import { callChatStream } from "@/lib/api";
import type { SpeakType } from "@/lib/hooks";
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
  // isSending は UI で描画しないので ref で OK (再レンダー不要)
  const isSendingRef = useRef(false);

  const sendChat = useCallback(
    async (userMsg: string, withImage = true) => {
      if (isSendingRef.current) return;
      isSendingRef.current = true;
      onEnter?.();
      acquireLock?.();

      // "💬 ユーザー発話" をチャット欄に即表示
      onBlocks([{ type: "text", content: `💬 ${userMsg}`, style: "emphasis" }]);

      const uri = withImage ? await cameraRef.current?.takePicture() : null;
      try {
        await callChatStream(apiUrl, userMsg, uri ?? null, sessionId, (ev: StageEvent) => {
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
        });
      } catch (err) {
        console.warn("[Chat] error:", err);
        onBlocks([
          { type: "alert", message: "エラーが発生しました", severity: "warning" },
        ]);
      } finally {
        releaseLock?.();
        // conversation を抜けるまで少し待つ (TTS 完了後)
        setTimeout(() => onExit?.(), 3000);
        isSendingRef.current = false;
      }
    },
    [apiUrl, sessionId, cameraRef,
     onBlocks, onSpeak, onEnter, onExit, acquireLock, releaseLock],
  );

  return { sendChat };
}
