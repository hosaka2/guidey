import { type ReactNode, forwardRef } from "react";
import { StyleSheet } from "react-native";

import { BlockRenderer } from "@/components/BlockRenderer";
import { CameraView, type CameraViewHandle } from "@/components/CameraView";
import { View } from "@/components/ui";
import type { Block } from "@/lib/types";

type Props = {
  textBlocks: Block[];
  timerBlocks: Block[];
  mediaBlocks: Block[];
  instructionCard?: ReactNode;
  bottomBar: ReactNode;
};

/**
 * スマートグラス HUD レイアウト (最小情報密度)。
 *   - カメラは背景として必要 (文脈理解のため)
 *   - 指示カードを画面中央に大きく 1 枚
 *   - blocks は重要なもの数件のみ、画面下にスタック
 *   - bottomBar は最小ボタンのみ (通常は音声操作想定)
 *
 * 注: 現時点は骨格のみ。UX は実機 (Xreal / Rokid / Meta Quest の AR モード等) で
 * 試行しながら詰める。
 */
export const SmartGlassesLayout = forwardRef<CameraViewHandle, Props>(
  ({ textBlocks, timerBlocks, mediaBlocks, instructionCard, bottomBar }, cameraRef) => {
    // HUD では blocks を集約。重要度順 (alert > timer > text > media)。
    const priorityBlocks: Block[] = [
      ...textBlocks.filter((b) => b.type === "alert"),
      ...timerBlocks,
      ...textBlocks.filter((b) => b.type !== "alert"),
      ...mediaBlocks,
    ].slice(0, 2); // 最大 2 件

    return (
      <View style={styles.root}>
        <View style={StyleSheet.absoluteFill}>
          <CameraView ref={cameraRef} />
        </View>

        <View style={styles.overlay}>
          {instructionCard ? (
            <View style={styles.instructionArea}>{instructionCard}</View>
          ) : null}

          {priorityBlocks.length > 0 ? (
            <View style={styles.blocks}>
              <BlockRenderer blocks={priorityBlocks} />
            </View>
          ) : null}

          <View style={styles.bottomBar}>{bottomBar}</View>
        </View>
      </View>
    );
  },
);
SmartGlassesLayout.displayName = "SmartGlassesLayout";

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "space-between",
    alignItems: "center",
    padding: 24,
    gap: 16, // ui-styling: gap で要素間隔
  },
  instructionArea: {
    width: "90%",
    maxWidth: 800,
  },
  blocks: {
    width: "80%",
    maxWidth: 600,
    gap: 8,
  },
  bottomBar: {
    alignSelf: "stretch",
  },
});
