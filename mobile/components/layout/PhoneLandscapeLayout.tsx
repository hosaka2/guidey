import { type ReactNode, forwardRef } from "react";
import { StyleSheet } from "react-native";

import { CameraView, type CameraViewHandle } from "@/components/CameraView";
import { MediaPanel } from "@/components/MediaPanel";
import { TextPanel } from "@/components/TextPanel";
import { TimerPanel } from "@/components/TimerPanel";
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
 * 手持ち横持ちレイアウト (VR ゴーグル装着 *なし*)。
 * 3 カラム構成で情報密度を高めに。
 *   LEFT  (30%): Timer (上 1/3) + Chat (下 2/3)
 *   CENTER (40%): カメラ透過 (instruction カードが下部に重なる)
 *   RIGHT (30%): メディア (画像・動画)
 */
export const PhoneLandscapeLayout = forwardRef<CameraViewHandle, Props>(
  ({ textBlocks, timerBlocks, mediaBlocks, instructionCard, bottomBar }, cameraRef) => {
    return (
      <View style={styles.root}>
        <View style={StyleSheet.absoluteFill}>
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
PhoneLandscapeLayout.displayName = "PhoneLandscapeLayout";

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  overlay: { ...StyleSheet.absoluteFillObject },
  columns: { flex: 1, flexDirection: "row" },
  left: { width: "30%", margin: 10 },
  timerArea: { flex: 1 },
  chatArea: { flex: 2 },
  center: { width: "40%" },
  right: { width: "30%", margin: 10 },
  instructionCard: {
    position: "absolute",
    bottom: 10,
    left: "30%",
    width: "40%",
    paddingHorizontal: 4,
  },
  bottomBar: { marginHorizontal: 10, marginBottom: 6 },
});
