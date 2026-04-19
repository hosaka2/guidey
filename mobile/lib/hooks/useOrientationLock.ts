import { useEffect } from "react";
import * as ScreenOrientation from "expo-screen-orientation";

import { useLayoutVariant } from "./useLayoutVariant";

/**
 * Settings の layoutVariant に応じて画面向きをロックする。
 *
 * - smart-glasses / phone-vr: 横向き固定 (左右どちらでも OK)
 * - phone-landscape (手持ちスマホモード): ロックしない (ユーザー任せ、通常縦持ち)
 *
 * guide / explore 画面の useEffect で呼ぶ。画面 unmount 時に lock を解除する。
 */
export function useOrientationLock() {
  const variant = useLayoutVariant();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (variant === "smart-glasses" || variant === "phone-vr") {
          await ScreenOrientation.lockAsync(
            ScreenOrientation.OrientationLock.LANDSCAPE,
          );
        } else {
          await ScreenOrientation.unlockAsync();
        }
      } catch (e) {
        if (__DEV__ && !cancelled) console.warn("[orientation] lock failed:", e);
      }
    })();
    return () => {
      cancelled = true;
      ScreenOrientation.unlockAsync().catch(() => {});
    };
  }, [variant]);
}
