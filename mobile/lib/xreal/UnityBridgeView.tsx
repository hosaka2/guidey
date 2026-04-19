import { useEffect } from "react";
import { StyleSheet, View } from "react-native";

import { ExpoUnityView } from "expo-unity-view";

import { unityBridge } from "./bridge";

/**
 * アプリ root に 1 個だけマウントする Unity ホスト View。
 * ネイティブ側 UnityManager が UnityPlayer を singleton で保持するので、
 * この View の mount/unmount では Unity プロセスは破棄されない。
 *
 * @param visible true = 全画面描画。XR Loader が起動しグラスに Unity の描画が
 *   届く代わり、スマホ画面は SurfaceView に覆われる。
 *   false = 1×1 hidden。スマホ画面に RN UI を残したまま裏で撮影のみ行う用途。
 */
export function UnityBridgeView({ visible = false }: { visible?: boolean } = {}) {
  useEffect(() => {
    unityBridge.start();
    return () => unityBridge.stop();
  }, []);

  return (
    <View style={visible ? styles.fullscreen : styles.hidden} pointerEvents="none">
      <ExpoUnityView style={StyleSheet.absoluteFill} />
    </View>
  );
}

const styles = StyleSheet.create({
  fullscreen: { ...StyleSheet.absoluteFillObject },
  hidden: {
    position: "absolute",
    width: 1,
    height: 1,
    top: 0,
    left: 0,
    opacity: 0,
  },
});
