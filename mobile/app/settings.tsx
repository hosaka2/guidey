import { useCallback, useEffect, useState } from "react";
import { Alert, Platform, ScrollView, StyleSheet } from "react-native";

import { Pressable, Text, View } from "@/components/ui";
import { type CameraSource, useApiContext } from "@/contexts/ApiContext";
import type { EdgeMode } from "@/lib/edge-llm";
import {
  deleteModel,
  type DownloadProgress,
  downloadModel,
  isModelReady,
} from "@/lib/edge-llm/model-manager";
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
  { value: "gemma-local", label: "Gemma 4 E2B (VLM)", hint: "オンデバイス llama.rn, 画像入力対応 (約 1.9GB)" },
];

const LAYOUTS: { value: ThemeVariant; label: string; hint: string }[] = [
  { value: "phone-landscape", label: "スマホ", hint: "スマホ手持ち用" },
  { value: "phone-vr", label: "VR ゴーグル", hint: "Cardboard 系、両目ステレオ分割" },
  { value: "smart-glasses", label: "スマートグラス", hint: "Xreal / Rokid、HUD (透過、カメラ非表示)" },
];

const CAMERAS: { value: CameraSource; label: string; hint: string }[] = [
  { value: "phone-back", label: "スマホ背面カメラ", hint: "expo-camera (既定)" },
  { value: "xreal-eye", label: "XREAL Eye", hint: "Beam Pro + XREAL SDK (Android 専用)" },
];

type ModelStatus =
  | { kind: "unknown" }
  | { kind: "missing" }
  | { kind: "ready" }
  | { kind: "downloading"; progress: DownloadProgress }
  | { kind: "error"; message: string };

function useEdgeModelStatus() {
  const [status, setStatus] = useState<ModelStatus>({ kind: "unknown" });

  const refresh = useCallback(async () => {
    const ready = await isModelReady();
    setStatus({ kind: ready ? "ready" : "missing" });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const download = useCallback(async () => {
    setStatus({
      kind: "downloading",
      progress: { asset: "main", totalBytes: 0, writtenBytes: 0, percent: 0 },
    });
    try {
      await downloadModel((p) => setStatus({ kind: "downloading", progress: p }));
      setStatus({ kind: "ready" });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const remove = useCallback(async () => {
    try {
      await deleteModel();
      setStatus({ kind: "missing" });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  return { status, download, remove, refresh };
}

function EdgeModelControls() {
  const { status, download, remove } = useEdgeModelStatus();

  const confirmDelete = () =>
    Alert.alert("モデルを削除", "ダウンロード済みの Gemma モデル (約 1.9GB) を削除します。", [
      { text: "キャンセル", style: "cancel" },
      { text: "削除", style: "destructive", onPress: remove },
    ]);

  return (
    <View style={styles.subCard}>
      {status.kind === "unknown" && <Text fontSize="$2" opacity={0.6}>状態確認中...</Text>}

      {status.kind === "missing" && (
        <>
          <Text fontSize="$2" opacity={0.7}>未ダウンロード</Text>
          <Pressable
            onPress={download}
            style={({ pressed }) => [styles.actionButton, pressed && { opacity: 0.85 }]}
          >
            <Text color="#fff" fontWeight="700">ダウンロード (約 1.9GB)</Text>
          </Pressable>
        </>
      )}

      {status.kind === "ready" && (
        <>
          <Text fontSize="$2" opacity={0.7}>✓ ダウンロード済み</Text>
          <Pressable
            onPress={confirmDelete}
            style={({ pressed }) => [styles.actionButtonDanger, pressed && { opacity: 0.85 }]}
          >
            <Text color="#fff" fontWeight="700">削除</Text>
          </Pressable>
        </>
      )}

      {status.kind === "downloading" && (
        <>
          <Text fontSize="$2" opacity={0.7}>
            ダウンロード中: {status.progress.asset} {status.progress.percent.toFixed(0)}%
          </Text>
          <View style={styles.progressBarTrack}>
            <View
              style={[
                styles.progressBarFill,
                { width: `${Math.min(100, status.progress.percent)}%` },
              ]}
            />
          </View>
        </>
      )}

      {status.kind === "error" && (
        <>
          <Text fontSize="$2" color="#d00">エラー: {status.message}</Text>
          <Pressable
            onPress={download}
            style={({ pressed }) => [styles.actionButton, pressed && { opacity: 0.85 }]}
          >
            <Text color="#fff" fontWeight="700">リトライ</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

export default function SettingsScreen() {
  const {
    edgeMode, setEdgeMode,
    layoutVariant, setLayoutVariant,
    cameraSource, setCameraSource,
  } = useApiContext();

  const handleCameraSelect = (value: CameraSource) => {
    if (value === "xreal-eye" && !IS_ANDROID) {
      warnXrealNotSupported();
      return;
    }
    setCameraSource(value);
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {/* === エッジ LLM === */}
      <View gap="$2">
        <Text fontSize="$5" fontWeight="600" color="$color">エッジ LLM</Text>
        <Text fontSize="$2" color="$color" opacity={0.5}>
          Stage1 (高速判定) をどこで実行するかを選択。クラウド以外は
          オンデバイス推論 + BE 同期 (/periodic/sync)。
        </Text>
        {EDGE_MODES.map((m) => {
          const selected = edgeMode === m.value;
          return (
            <View key={m.value} gap="$1">
              <Pressable
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
              {m.value === "gemma-local" && <EdgeModelControls />}
            </View>
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

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, gap: 16, paddingBottom: 40 },
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
  subCard: {
    marginLeft: 12,
    padding: 10,
    borderRadius: 10,
    backgroundColor: "#f6f6f8",
    gap: 8,
  },
  actionButton: {
    backgroundColor: "#2F95DC",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignSelf: "flex-start",
  },
  actionButtonDanger: {
    backgroundColor: "#d0021b",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignSelf: "flex-start",
  },
  progressBarTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "#e0e0e0",
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: "#2F95DC",
  },
});
