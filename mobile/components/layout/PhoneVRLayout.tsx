import { type ReactNode, forwardRef } from "react";
import { StyleSheet } from "react-native";

import { BlockRenderer } from "@/components/BlockRenderer";
import { StereoCameraView, type StereoCameraHandle } from "@/components/StereoCameraView";
import { View } from "@/components/ui";
import type { Block } from "@/lib/types";

type Props = {
  textBlocks: Block[];
  timerBlocks: Block[];
  mediaBlocks: Block[];
  instructionCard?: ReactNode;
  bottomBar: ReactNode;
};

/** 両目中央のガター幅 (IPD 調整用の黒帯)。 */
const GUTTER = 8;

/**
 * スマホを Cardboard 系 VR ゴーグルに装着する際の**両眼ステレオ分割**レイアウト。
 *
 *  ┌──────────────┬──────────────┐
 *  │  LEFT EYE    │  RIGHT EYE   │
 *  │   [camera]   │   [camera]   │
 *  │   [HUD UI]   │   [HUD UI]   │
 *  └──────────────┴──────────────┘
 *         ↑ gutter (IPD)
 *
 * カメラ描画は `StereoCameraView` に委譲:
 *   - iOS: `CAReplicatorLayer` で 60fps 両眼同じ映像
 *   - その他: view-shot で左目を右目にミラー (低 fps フォールバック)
 *
 * UI オーバーレイは RN 側でシンプルに左右ミラー。情報量は抑えめ (maxBlocks=3)。
 */
export const PhoneVRLayout = forwardRef<StereoCameraHandle, Props>(
  ({ textBlocks, timerBlocks, mediaBlocks, instructionCard, bottomBar }, ref) => {
    // 片目に出すブロックは alert > timer > text の優先順、3 件まで。画像は VR で歪むので除外。
    const hudBlocks: Block[] = [
      ...textBlocks.filter((b) => b.type === "alert"),
      ...timerBlocks,
      ...textBlocks.filter((b) => b.type !== "alert"),
    ].slice(0, 3);

    // 未使用 warning 回避 (将来 mediaBadge で使う可能性あり)
    void mediaBlocks;

    const EyeHud = (
      <View style={styles.eyeOverlay} pointerEvents="box-none">
        {instructionCard ? <View style={styles.instructionArea}>{instructionCard}</View> : null}
        {hudBlocks.length > 0 ? (
          <View style={styles.hud}>
            <BlockRenderer blocks={hudBlocks} />
          </View>
        ) : null}
      </View>
    );

    return (
      <View style={styles.root}>
        {/* カメラは全画面 1 枚。内部で両目ミラーされる。 */}
        <StereoCameraView ref={ref} gutter={GUTTER} />

        {/* UI オーバーレイ: 両目に同じ HUD を左右ミラー */}
        <View style={styles.overlay} pointerEvents="box-none">
          <View style={styles.eye}>{EyeHud}</View>
          <View style={[styles.gutter, { width: GUTTER }]} />
          <View style={styles.eye}>{EyeHud}</View>
        </View>

        {/* BottomBar は両目の下に跨いで 1 本 */}
        <View style={styles.bottomBar}>{bottomBar}</View>
      </View>
    );
  },
);
PhoneVRLayout.displayName = "PhoneVRLayout";

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  overlay: { ...StyleSheet.absoluteFillObject, flexDirection: "row" },
  eye: { flex: 1, overflow: "hidden" },
  gutter: { backgroundColor: "transparent" }, // ガターは StereoCameraView 側で黒
  eyeOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    alignItems: "center",
    padding: 16,
    gap: 8,
  },
  instructionArea: { width: "92%" },
  hud: { width: "92%", gap: 6 },
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.65)",
  },
});
