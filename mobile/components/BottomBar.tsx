import { StyleSheet, Pressable } from "react-native";
import { View, Text } from "@tamagui/core";
import { Feather } from "@expo/vector-icons";

type Props = {
  onBack: () => void;
  onTextInput: () => void;
  voiceEnabled: boolean;
  onToggleVoice: () => void;
  // プランモードのみ
  showAutoToggle?: boolean;
  isAutonomous?: boolean;
  onToggleAutonomous?: () => void;
};

export function BottomBar({
  onBack,
  onTextInput,
  voiceEnabled,
  onToggleVoice,
  showAutoToggle = false,
  isAutonomous = false,
  onToggleAutonomous,
}: Props) {
  return (
    <View style={styles.bar}>
      {/* 左側 */}
      <View style={styles.left}>
        <Pressable style={styles.btn} onPress={onBack}>
          <Feather name="chevron-left" size={20} color="#fff" />
        </Pressable>

        <Pressable
          style={[styles.btn, voiceEnabled && styles.btnActive]}
          onPress={onToggleVoice}
        >
          <Feather
            name={voiceEnabled ? "mic" : "mic-off"}
            size={18}
            color={voiceEnabled ? "#fff" : "#999"}
          />
        </Pressable>

        <Pressable style={styles.textBtn} onPress={onTextInput}>
          <Feather name="edit-2" size={16} color="#fff" />
          <Text color="#fff" fontSize={11}>質問</Text>
        </Pressable>
      </View>

      {/* 右側 */}
      <View style={styles.right}>
        {showAutoToggle && onToggleAutonomous && (
          <Pressable
            style={[styles.btn, isAutonomous && styles.btnAutoActive]}
            onPress={onToggleAutonomous}
          >
            <Feather
              name={isAutonomous ? "pause" : "play"}
              size={18}
              color="#fff"
            />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  btn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  btnActive: {
    backgroundColor: "#4ADE80",
  },
  btnAutoActive: {
    backgroundColor: "#FF6B35",
  },
  textBtn: {
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
  },
});
