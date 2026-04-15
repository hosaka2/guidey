import { CameraView as ExpoCameraView, useCameraPermissions } from "expo-camera";
import { forwardRef, useImperativeHandle, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";

export type CameraViewHandle = {
  takePicture: () => Promise<string | null>;
};

export const CameraView = forwardRef<CameraViewHandle>((_props, ref) => {
  const cameraRef = useRef<ExpoCameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();

  useImperativeHandle(ref, () => ({
    takePicture: async () => {
      if (!cameraRef.current) return null;
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.5,
        shutterSound: false,
      });
      return photo?.uri ?? null;
    },
  }));

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.message}>
          カメラへのアクセスを許可してください
        </Text>
        <Text style={styles.link} onPress={requestPermission}>
          許可する
        </Text>
      </View>
    );
  }

  return (
    <ExpoCameraView ref={cameraRef} style={styles.camera} facing="back" />
  );
});

CameraView.displayName = "CameraView";

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
  },
  camera: {
    flex: 1,
  },
  message: {
    color: "#fff",
    fontSize: 16,
    textAlign: "center",
    marginBottom: 12,
  },
  link: {
    color: "#2f95dc",
    fontSize: 16,
    textDecorationLine: "underline",
  },
});
