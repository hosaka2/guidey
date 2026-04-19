import { requireNativeView } from "expo";
import { NativeModulesProxy } from "expo-modules-core";
import type { ComponentType, Ref } from "react";
import type { ViewProps } from "react-native";

export type NativeStereoCameraViewProps = ViewProps & {
  /** 2 プレビュー間の中央ガター幅 (px)。既定 8。 */
  gutter?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref?: Ref<any>;
};

/**
 * iOS 限定: CAReplicatorLayer による 2 プレビューのステレオカメラ View。
 * Android では requireNativeView が throw するので、RN 側ラッパーがフォールバックする。
 */
let NativeView: ComponentType<NativeStereoCameraViewProps> | null = null;
try {
  NativeView = requireNativeView<NativeStereoCameraViewProps>("CameraMirrorModule");
} catch {
  NativeView = null;
}

export const NativeStereoCameraView = NativeView;

/** viewTag を渡して async takePicture() を呼ぶ。 */
export async function takePictureAsync(viewTag: number): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (NativeModulesProxy as any).CameraMirrorModule;
  if (!mod?.takePicture) return null;
  try {
    const uri = await mod.takePicture(viewTag);
    return uri ?? null;
  } catch (e) {
    console.warn("[camera-mirror] takePicture failed:", e);
    return null;
  }
}

export const isNativeAvailable = NativeView !== null;
