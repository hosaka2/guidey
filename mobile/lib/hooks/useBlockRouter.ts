import { useMemo } from "react";
import type { Block } from "@/lib/types";

/**
 * ブロックを種類別に振り分ける (3カラムレイアウト用).
 *
 * 左パネル: text, alert (チャットバブル)
 * 左上: timer
 * 右パネル: image, video (メディア)
 */
export function useBlockRouter(blocks: Block[]) {
  return useMemo(() => {
    const textBlocks: Block[] = [];
    const timerBlocks: Block[] = [];
    const mediaBlocks: Block[] = [];

    for (const b of blocks) {
      switch (b.type) {
        case "text":
        case "alert":
          textBlocks.push(b);
          break;
        case "timer":
          timerBlocks.push(b);
          break;
        case "image":
        case "video":
          mediaBlocks.push(b);
          break;
      }
    }

    return { textBlocks, timerBlocks, mediaBlocks };
  }, [blocks]);
}
