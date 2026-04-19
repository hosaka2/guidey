import { type ReactNode, forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { StyleSheet } from "react-native";

import { CameraView, type CameraViewHandle } from "@/components/CameraView";
import { MediaPanel } from "@/components/MediaPanel";
import { TextPanel } from "@/components/TextPanel";
import { TimerPanel } from "@/components/TimerPanel";
import { View } from "@/components/ui";
import type { Block } from "@/lib/types";
import { clearBlocksOnGlasses, showBlocksOnGlasses } from "@/lib/xreal";

type Props = {
  textBlocks: Block[];
  timerBlocks: Block[];
  mediaBlocks: Block[];
  instructionCard?: ReactNode;
  bottomBar: ReactNode;
};

/**
 * 光学シースルー型スマートグラス (XREAL 1S / Rokid 等) 用レイアウト。
 *
 * PhoneLandscapeLayout とほぼ同じ 3 カラム構造だが、
 * 中央のカメラ映像は描画しない (黒 = 透過でレンズ越しの実世界が見える)。
 *
 * CameraView は推論用に常に 1×1 offscreen でマウント:
 *   - cameraSource = "phone-back" → この CameraView で撮影
 *   - cameraSource = "xreal-eye"  → Unity (XREAL Eye) を使うが、失敗時にこの CameraView にフォールバック
 */
export const SmartGlassesLayout = forwardRef<CameraViewHandle, Props>(
  ({ textBlocks, timerBlocks, mediaBlocks, instructionCard, bottomBar }, ref) => {
    const cameraRef = useRef<CameraViewHandle>(null);
    useImperativeHandle(ref, () => ({
      takePicture: () => cameraRef.current?.takePicture() ?? Promise.resolve(null),
    }));

    // Unity (XREAL グラス) への block 転送。
    // RN 側の描画 (このレイアウト) は補助/デバッグ用として残しつつ、
    // 同じ block セットを Unity の World Space Canvas にもミラーする。
    const allBlocks = useMemo<Block[]>(
      () => [...textBlocks, ...timerBlocks, ...mediaBlocks],
      [textBlocks, timerBlocks, mediaBlocks],
    );
    useEffect(() => {
      void showBlocksOnGlasses(allBlocks);
    }, [allBlocks]);
    useEffect(() => {
      return () => {
        void clearBlocksOnGlasses();
      };
    }, []);

    return (
      <View style={styles.root}>
        {/* 推論用に画面外 1x1 で常にマウント (グラスには映さない)。
            xreal-eye 選択時も Unity 側のタイムアウト時に phone-back にフォールバックするため必要。 */}
        <View style={styles.offscreenCamera} pointerEvents="none">
          <CameraView ref={cameraRef} />
        </View>

        <View style={styles.overlay}>
          <View style={styles.columns}>
            <View style={styles.left}>
              <View style={styles.timerArea}>
                <TimerPanel blocks={timerBlocks} />
              </View>
              <View style={styles.chatArea}>
                <TextPanel blocks={textBlocks} />
              </View>
            </View>

            <View style={styles.center} />

            <View style={styles.right}>
              <MediaPanel blocks={mediaBlocks} />
            </View>
          </View>

          <View style={styles.bottomBar}>{bottomBar}</View>
        </View>

        {instructionCard ? (
          <View style={styles.instructionCard}>{instructionCard}</View>
        ) : null}
      </View>
    );
  },
);
SmartGlassesLayout.displayName = "SmartGlassesLayout";

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" }, // グラスでは加算合成 → 黒 = 透明
  overlay: { ...StyleSheet.absoluteFillObject },
  columns: { flex: 1, flexDirection: "row" },
  left: { width: "30%", margin: 10 },
  timerArea: { flex: 1 },
  chatArea: { flex: 2 },
  center: { width: "40%" }, // カメラ映像を描画しない (実世界を透過)
  right: { width: "30%", margin: 10 },
  instructionCard: {
    position: "absolute",
    bottom: 10,
    left: "30%",
    width: "40%",
    paddingHorizontal: 4,
  },
  bottomBar: { marginHorizontal: 10, marginBottom: 6 },
  offscreenCamera: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
  },
});
