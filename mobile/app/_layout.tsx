import FontAwesome from "@expo/vector-icons/FontAwesome";
import { useFonts } from "expo-font";
import { Stack, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { TamaguiProvider } from "@tamagui/core";
import "react-native-reanimated";

import config from "../tamagui.config";
import { ApiProvider, useApiContext } from "@/contexts/ApiContext";
import { useLayoutVariant } from "@/lib/hooks";
import { UnityBridgeView } from "@/lib/xreal";

/**
 * Unity を mount する条件:
 *   - Settings の layoutVariant が smart-glasses
 *   - かつ cameraSource が xreal-eye (Unity 経由の Eye カメラを使う設定)
 *
 * この両方を満たさない場合は Unity を一切起動させない (RN UI 単独で動く)。
 * SurfaceView が一瞬でも出るとスマホ画面の RN UI が隠れるため、mount 自体しない。
 *
 * visible は撮影画面 (guide/explore) 時のみ true → Unity 全画面でグラスに描画。
 * それ以外では 1×1 hidden (UnityPlayer は裏で動き続けるが画面には出ない)。
 */
function UnityHost() {
  const variant = useLayoutVariant();
  const { cameraSource } = useApiContext();
  const segments = useSegments();
  const onCaptureScreen = segments[0] === "guide" || segments[0] === "explore";

  if (variant !== "smart-glasses" || cameraSource !== "xreal-eye") return null;
  return <UnityBridgeView visible={onCaptureScreen} />;
}

export { ErrorBoundary } from "expo-router";

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

SplashScreen.preventAutoHideAsync().catch(() => {
  // 既に閉じていた場合などは無視
});

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
    ...FontAwesome.font,
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (!loaded) return;
    // Unity (XREAL XR Loader) が stereo display を取り、Unity 標準のスプラッシュ
    // (Made with Unity ロゴ) がグラスに 2〜3 秒表示される。その間 RN 側も
    // splash を出したままにすることで、ユーザーには「起動中」として自然に見える。
    const t = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {});
    }, 5000);
    return () => clearTimeout(t);
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return (
    <ApiProvider>
      <TamaguiProvider config={config} defaultTheme="light">
        <Stack>
          <Stack.Screen
            name="(tabs)"
            options={{ headerShown: false, orientation: "portrait" }}
          />
          <Stack.Screen
            name="goal"
            options={{
              headerShown: false,
              animation: "slide_from_right",
              orientation: "portrait",
            }}
          />
          <Stack.Screen
            name="guide"
            options={{
              headerShown: false,
              animation: "slide_from_right",
              // orientation はここで固定せず、画面内で layoutVariant に応じて
              // expo-screen-orientation で動的にロックする。
            }}
          />
          <Stack.Screen
            name="explore"
            options={{
              headerShown: false,
              animation: "slide_from_right",
            }}
          />
          <Stack.Screen
            name="settings"
            options={{
              presentation: "modal",
              headerTitle: "Settings",
              orientation: "portrait",
            }}
          />
        </Stack>
        {/* XREAL SDK アダプタ。Android 以外では自動的に null を返す。
            guide/explore 中だけ Unity 全画面、それ以外は 1×1 hidden で RN UI を前面に。 */}
        <UnityHost />
      </TamaguiProvider>
    </ApiProvider>
  );
}
