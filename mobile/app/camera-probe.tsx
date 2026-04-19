import { useEffect, useRef, useState } from "react";
import { Alert, Image, ScrollView, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Camera, useCameraDevices } from "react-native-vision-camera";

import { Pressable, Text, View } from "@/components/ui";

/**
 * Beam Pro の全カメラを列挙して、どれが XREAL Eye か特定するための調査画面。
 *
 * 各カメラをタップすると、そのカメラで 1 枚撮影して画面にプレビュー。
 * 「自分が映る」「手元 (視界) が映る」「真っ黒」等で判別する。
 *
 * 用途:
 *   1. どの id が XREAL Eye か特定 (debug)
 *   2. 特定した id を useCameraCapture に組み込んで本採用
 */
export default function CameraProbe() {
  const router = useRouter();
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  const devices = useCameraDevices();
  const cameraRef = useRef<Camera>(null);
  const selectedDevice = devices.find((d) => d.id === selectedId) ?? null;

  useEffect(() => {
    (async () => {
      const status = await Camera.requestCameraPermission();
      setHasPermission(status === "granted");
    })();
  }, []);

  const onTakePhoto = async () => {
    if (!cameraRef.current || capturing) return;
    try {
      setCapturing(true);
      const photo = await cameraRef.current.takePhoto();
      setPhotoUri(`file://${photo.path}`);
    } catch (e) {
      Alert.alert("撮影失敗", String(e));
    } finally {
      setCapturing(false);
    }
  };

  if (hasPermission === false) {
    return (
      <View style={styles.center}>
        <Text>カメラ権限がありません</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Pressable onPress={() => router.back()} style={styles.backBtn}>
        <Text>← 戻る</Text>
      </Pressable>

      <Text style={styles.h1}>カメラ調査</Text>
      <Text style={styles.muted}>
        検出数: {devices.length}。各カメラをタップして撮影。
      </Text>

      {devices.map((d) => (
        <Pressable
          key={d.id}
          onPress={() => {
            setSelectedId(d.id);
            setPhotoUri(null);
          }}
          style={[styles.card, selectedId === d.id && styles.cardActive]}
        >
          <Text fontWeight="700">id={d.id}</Text>
          <Text style={styles.muted}>position: {d.position}</Text>
          <Text style={styles.muted}>
            hasFlash: {String(d.hasFlash)} / physicalDevices:{" "}
            {d.physicalDevices?.join(",") ?? "-"}
          </Text>
          <Text style={styles.muted}>name: {d.name}</Text>
        </Pressable>
      ))}

      {selectedDevice ? (
        <View style={styles.previewBox}>
          <Camera
            ref={cameraRef}
            device={selectedDevice}
            isActive={true}
            photo={true}
            style={styles.camera}
          />
          <Pressable
            style={styles.shutter}
            onPress={onTakePhoto}
            disabled={capturing}
          >
            <Text color="#fff">{capturing ? "撮影中..." : "📸 撮影"}</Text>
          </Pressable>
        </View>
      ) : null}

      {photoUri ? (
        <View>
          <Text fontWeight="700" style={{ marginTop: 16 }}>
            撮影結果 (id={selectedId})
          </Text>
          <Image source={{ uri: photoUri }} style={styles.photo} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, gap: 12, paddingBottom: 80 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  backBtn: { alignSelf: "flex-start", padding: 8 },
  h1: { fontSize: 20, fontWeight: "700" },
  muted: { color: "#666", fontSize: 12 },
  card: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    padding: 10,
    gap: 2,
  },
  cardActive: { borderColor: "#2F95DC", backgroundColor: "#e6f3fb" },
  previewBox: { height: 280, marginTop: 8, borderRadius: 10, overflow: "hidden" },
  camera: { flex: 1 },
  shutter: {
    position: "absolute",
    bottom: 10,
    alignSelf: "center",
    backgroundColor: "#000000AA",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  photo: { width: "100%", aspectRatio: 4 / 3, marginTop: 8, borderRadius: 10 },
});
