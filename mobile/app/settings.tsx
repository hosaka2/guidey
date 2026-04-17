import { useState } from "react";
import { TextInput, StyleSheet } from "react-native";

import { Pressable, Text, View } from "@/components/ui";
import { useApiContext } from "@/contexts/ApiContext";
import { testConnection } from "@/lib/api";

export default function SettingsScreen() {
  const { apiUrl, setApiUrl } = useApiContext();
  const [status, setStatus] = useState<"idle" | "testing" | "ok" | "error">(
    "idle"
  );

  const handleTest = async () => {
    setStatus("testing");
    const ok = await testConnection(apiUrl);
    setStatus(ok ? "ok" : "error");
  };

  return (
    <View flex={1} backgroundColor="$background" padding="$4" gap="$4">
      <View gap="$2">
        <Text fontSize="$5" fontWeight="600" color="$color">
          API URL
        </Text>
        <TextInput
          style={styles.input}
          value={apiUrl}
          onChangeText={setApiUrl}
          placeholder="https://xxxx.ngrok-free.app"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text fontSize="$2" color="$color" opacity={0.5}>
          ngrok URL を入力してください
        </Text>
      </View>

      <Pressable
        onPress={handleTest}
        disabled={status === "testing"}
        style={({ pressed }) => [
          styles.testButton,
          pressed && { opacity: 0.8 },
        ]}
      >
        <Text color="#fff" fontWeight="700" textAlign="center" fontSize="$4">
          {status === "testing" ? "接続テスト中..." : "接続テスト"}
        </Text>
      </Pressable>

      {status === "ok" && (
        <Text color="#22c55e" fontWeight="600">
          接続成功
        </Text>
      )}
      {status === "error" && (
        <Text color="#ef4444" fontWeight="600">
          接続失敗 - URLを確認してください
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    backgroundColor: "#fff",
    color: "#1A1A1A",
  },
  testButton: {
    backgroundColor: "#2F95DC",
    paddingVertical: 14,
    borderRadius: 12,
  },
});
