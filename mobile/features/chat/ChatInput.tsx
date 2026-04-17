import { StyleSheet, TextInput } from "react-native";
import { Feather } from "@expo/vector-icons";

import { Pressable, View } from "@/components/ui";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  disabled?: boolean;
};

/**
 * チャット入力バー (画面下部にオーバーレイ)。
 * visible 制御は親で行う (showTextInput state)。
 */
export function ChatInput({ value, onChange, onSubmit, onClose, disabled }: Props) {
  return (
    <View style={styles.bar}>
      <TextInput
        style={styles.input}
        placeholder="質問や指示を入力..."
        placeholderTextColor="#999"
        value={value}
        onChangeText={onChange}
        autoFocus
        returnKeyType="send"
        onSubmitEditing={onSubmit}
      />
      <Pressable
        onPress={onSubmit}
        disabled={!value.trim() || disabled}
        style={[styles.send, (!value.trim() || disabled) && { opacity: 0.5 }]}
      >
        <Feather name="send" size={20} color="#fff" />
      </Pressable>
      <Pressable onPress={onClose} style={styles.close}>
        <Feather name="x" size={18} color="#999" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8, // ui-styling: gap
    backgroundColor: "rgba(0,0,0,0.85)",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    backgroundColor: "#333",
    borderRadius: 20,
    borderCurve: "continuous",
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 15,
    color: "#fff",
  },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#2F95DC",
    alignItems: "center",
    justifyContent: "center",
  },
  close: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
});
