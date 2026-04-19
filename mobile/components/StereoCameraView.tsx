import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Platform, StyleSheet, Image, findNodeHandle } from "react-native";

import { CameraView as ExpoCameraWrapper, type CameraViewHandle } from "@/components/CameraView";
import { View } from "@/components/ui";
import {
  NativeStereoCameraView,
  isNativeAvailable,
  takePictureAsync as nativeTakePicture,
} from "camera-mirror";

export type StereoCameraHandle = CameraViewHandle;

type Props = {
  /** 両目中央のガター幅 (px)。 */
  gutter?: number;
};

/**
 * Cardboard 系 VR ゴーグル用のステレオカメラ表示。
 *
 * - iOS (ネイティブ module あり): `CAReplicatorLayer` で 60fps, 遅延ゼロ
 * - それ以外 (Android 等): `react-native-view-shot` + `<Image>` で低 fps ミラー
 *
 * 両モードとも `takePicture()` を提供し、呼び出し側は意識不要。
 */
export const StereoCameraView = forwardRef<StereoCameraHandle, Props>(
  ({ gutter = 8 }, ref) => {
    const useNative = Platform.OS === "ios" && isNativeAvailable;
    if (useNative) {
      return <NativeStereo ref={ref} gutter={gutter} />;
    }
    return <FallbackStereo ref={ref} gutter={gutter} />;
  },
);
StereoCameraView.displayName = "StereoCameraView";

// ============================================================================
// Native (iOS): CAReplicatorLayer
// ============================================================================

const NativeStereo = forwardRef<StereoCameraHandle, { gutter: number }>(
  ({ gutter }, ref) => {
     
    const viewRef = useRef<any>(null);
    useImperativeHandle(ref, () => ({
      takePicture: async () => {
        const tag = findNodeHandle(viewRef.current);
        if (tag == null) return null;
        return nativeTakePicture(tag);
      },
    }));
    if (!NativeStereoCameraView) return null;
    return (
      <NativeStereoCameraView
        ref={viewRef}
        style={StyleSheet.absoluteFill}
        gutter={gutter}
      />
    );
  },
);
NativeStereo.displayName = "NativeStereo";

// ============================================================================
// Fallback: view-shot ミラー
// ============================================================================

type ViewShotModule = {
  captureRef: (ref: unknown, opts: { result: "tmpfile"; quality: number; format: "jpg" }) => Promise<string>;
};

function loadViewShot(): ViewShotModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("react-native-view-shot") as ViewShotModule;
  } catch {
    return null;
  }
}

const MIRROR_INTERVAL_MS = 120; // ~8fps、バッテリーとのバランス

const FallbackStereo = forwardRef<StereoCameraHandle, { gutter: number }>(
  ({ gutter }, ref) => {
    const cameraRef = useRef<CameraViewHandle>(null);
    const leftContainerRef = useRef(null);
    const [mirrorUri, setMirrorUri] = useState<string | null>(null);
    const viewShot = useRef<ViewShotModule | null>(null);

    useImperativeHandle(ref, () => ({
      takePicture: () => cameraRef.current?.takePicture() ?? Promise.resolve(null),
    }));

    useEffect(() => {
      viewShot.current = loadViewShot();
      if (!viewShot.current) {
        console.log("[stereo/fallback] react-native-view-shot not installed, right eye will be blank");
        return;
      }
      let cancelled = false;
      const tick = async () => {
        if (cancelled || !viewShot.current || !leftContainerRef.current) return;
        try {
          const uri = await viewShot.current.captureRef(leftContainerRef.current, {
            result: "tmpfile",
            quality: 0.5,
            format: "jpg",
          });
          if (!cancelled) setMirrorUri(uri);
        } catch (e) {
          // 無音でスキップ (captureRef は画面遷移時に失敗しうる)
          if (__DEV__) console.log("[stereo/fallback] capture skipped", e);
        } finally {
          if (!cancelled) setTimeout(tick, MIRROR_INTERVAL_MS);
        }
      };
      tick();
      return () => {
        cancelled = true;
      };
    }, []);

    return (
      <View style={styles.fallbackRoot}>
        <View ref={leftContainerRef} collapsable={false} style={styles.eye}>
          <ExpoCameraWrapper ref={cameraRef} />
        </View>
        <View style={[styles.gutter, { width: gutter }]} />
        <View style={styles.eye}>
          {mirrorUri ? (
            <Image source={{ uri: mirrorUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : null}
        </View>
      </View>
    );
  },
);
FallbackStereo.displayName = "FallbackStereo";

const styles = StyleSheet.create({
  fallbackRoot: { ...StyleSheet.absoluteFillObject, flexDirection: "row", backgroundColor: "#000" },
  eye: { flex: 1, overflow: "hidden" },
  gutter: { backgroundColor: "#000" },
});
