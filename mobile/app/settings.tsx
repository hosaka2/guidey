import { Alert, Platform, StyleSheet, ScrollView } from "react-native";
import { useRouter } from "expo-router";

import { Pressable, Text, View } from "@/components/ui";
import { type CameraSource, useApiContext } from "@/contexts/ApiContext";
import type { EdgeMode } from "@/lib/edge-llm";
import type { ThemeVariant } from "@/lib/theme";

const IS_ANDROID = Platform.OS === "android";

/** XREAL 関連機能は Android のみ。iOS で選ばれた時の警告。 */
function warnXrealNotSupported(onCancel?: () => void) {
  Alert.alert(
    "XREAL は Android 専用です",
    "XREAL グラス + Beam Pro の機能は Android でのみ動作します。iOS では代わりにスマホ背面カメラが使用されます。",
    [{ text: "OK", onPress: onCancel }],
  );
}

const EDGE_MODES: { value: EdgeMode; label: string; hint: string }[] = [
  { value: "cloud", label: "クラウド", hint: "BE で Stage1 を実行 (既定)" },
  { value: "gemma-local", label: "Gemma 4 E2B (VLM)", hint: "オンデバイス llama.rn, 画像入力対応" },
];

const LAYOUTS: { value: ThemeVariant; label: string; hint: string }[] = [
  { value: "phone-landscape", label: "スマホ横持ち", hint: "手持ち用 3 カラム (既定)" },
  { value: "phone-vr", label: "VR ゴーグル", hint: "Cardboard 系、両目ステレオ分割" },
  { value: "smart-glasses", label: "スマートグラス", hint: "Xreal / Rokid、HUD (透過、カメラ非表示)" },
];

const CAMERAS: { value: CameraSource; label: string; hint: string }[] = [
  { value: "phone-back", label: "スマホ背面カメラ", hint: "expo-camera (既定)" },
  { value: "xreal-eye", label: "XREAL Eye", hint: "Beam Pro + XREAL SDK (Android 専用)" },
];

export default function SettingsScreen() {
  const router = useRouter();
  const {
    edgeMode, setEdgeMode,
    layoutVariant, setLayoutVariant,
    cameraSource, setCameraSource,
  } = useApiContext();

  // XREAL プリセット: レイアウト = smart-glasses, カメラ = xreal-eye
  const applyXrealPreset = () => {
    if (!IS_ANDROID) {
      warnXrealNotSupported();
      return;
    }
    setLayoutVariant("smart-glasses");
    setCameraSource("xreal-eye");
  };

  const handleCameraSelect = (value: CameraSource) => {
    if (value === "xreal-eye" && !IS_ANDROID) {
      warnXrealNotSupported();
      return;
    }
    setCameraSource(value);
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {/* === プリセット === */}
      <View gap="$2">
        <Text fontSize="$5" fontWeight="600" color="$color">プリセット</Text>
        <Pressable
          onPress={applyXrealPreset}
          style={({ pressed }) => [
            styles.preset,
            !IS_ANDROID && styles.cardDisabled,
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text color="#fff" fontWeight="700" fontSize="$4">
            XREAL 1S + Eye{!IS_ANDROID ? " (Android 専用)" : ""}
          </Text>
          <Text color="#fff" fontSize="$2" opacity={0.85}>
            レイアウト: スマートグラス / カメラ: XREAL Eye
          </Text>
        </Pressable>
      </View>

      {/* === エッジ LLM === */}
      <View gap="$2" marginTop="$4">
        <Text fontSize="$5" fontWeight="600" color="$color">エッジ LLM</Text>
        <Text fontSize="$2" color="$color" opacity={0.5}>
          Stage1 (高速判定) をどこで実行するかを選択。クラウド以外は
          オンデバイス推論 + BE 同期 (/periodic/sync)。
        </Text>
        {EDGE_MODES.map((m) => {
          const selected = edgeMode === m.value;
          return (
            <Pressable
              key={m.value}
              onPress={() => setEdgeMode(m.value)}
              style={({ pressed }) => [
                styles.card, selected && styles.cardActive, pressed && { opacity: 0.85 },
              ]}
            >
              <Text fontSize="$4" fontWeight="700" color={selected ? "#fff" : "$color"}>
                {m.label}
              </Text>
              <Text fontSize="$2" color={selected ? "#fff" : "$color"} opacity={selected ? 0.9 : 0.6}>
                {m.hint}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* === 表示モード === */}
      <View gap="$2" marginTop="$4">
        <Text fontSize="$5" fontWeight="600" color="$color">表示モード</Text>
        <Text fontSize="$2" color="$color" opacity={0.5}>
          使用するデバイスに合わせたレイアウトを選択。
        </Text>
        {LAYOUTS.map((l) => {
          const selected = layoutVariant === l.value;
          return (
            <Pressable
              key={l.value}
              onPress={() => setLayoutVariant(l.value)}
              style={({ pressed }) => [
                styles.card, selected && styles.cardActive, pressed && { opacity: 0.85 },
              ]}
            >
              <Text fontSize="$4" fontWeight="700" color={selected ? "#fff" : "$color"}>
                {l.label}
              </Text>
              <Text fontSize="$2" color={selected ? "#fff" : "$color"} opacity={selected ? 0.9 : 0.6}>
                {l.hint}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* === カメラソース === */}
      <View gap="$2" marginTop="$4">
        <Text fontSize="$5" fontWeight="600" color="$color">カメラソース</Text>
        <Text fontSize="$2" color="$color" opacity={0.5}>
          Stage1 判定用に画像を取得する経路。XREAL Eye は Android (Beam Pro) 限定で、
          未接続・未対応環境ではスマホ背面カメラにフォールバック。
        </Text>
        {CAMERAS.map((c) => {
          const selected = cameraSource === c.value;
          const disabled = c.value === "xreal-eye" && !IS_ANDROID;
          return (
            <Pressable
              key={c.value}
              onPress={() => handleCameraSelect(c.value)}
              style={({ pressed }) => [
                styles.card,
                selected && styles.cardActive,
                disabled && styles.cardDisabled,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text fontSize="$4" fontWeight="700" color={selected ? "#fff" : "$color"}>
                {c.label}
                {disabled ? " (iOS 非対応)" : ""}
              </Text>
              <Text fontSize="$2" color={selected ? "#fff" : "$color"} opacity={selected ? 0.9 : 0.6}>
                {c.hint}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* === デバッグ: カメラ調査 === */}
      <View gap="$2" marginTop="$4">
        <Text fontSize="$5" fontWeight="600" color="$color">デバッグ</Text>
        <Pressable
          onPress={() => router.push("/camera-probe" as never)}
          style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
        >
          <Text fontSize="$4" fontWeight="700">カメラ調査 (全カメラ列挙)</Text>
          <Text fontSize="$2" opacity={0.6}>
            Beam Pro の全カメラを列挙して、XREAL Eye がどの id か特定する
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
  preset: {
    backgroundColor: "#6B46C1",
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  card: {
    borderWidth: 1, borderColor: "#ddd", borderRadius: 12,
    padding: 12, backgroundColor: "#fff", gap: 4,
  },
  cardActive: {
    borderColor: "#2F95DC", backgroundColor: "#2F95DC",
  },
  cardDisabled: {
    opacity: 0.5,
  },
});
