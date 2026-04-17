import { useEffect, useState } from "react";
import { StyleSheet, Pressable, ScrollView } from "react-native";
import { View, Text } from "@tamagui/core";
import { Feather } from "@expo/vector-icons";
import Markdown from "react-native-markdown-display";

type StepInfo = {
  step_number: number;
  text: string;
  frame_url?: string;
};

type Props = {
  instruction: string | null;
  currentStep: number;
  totalSteps: number;
  steps: StepInfo[];
};

const ACCENT = "#FF6B35";

export function InstructionCard({
  instruction,
  currentStep,
  totalSteps,
  steps,
}: Props) {
  // 折り畳みは UI 内部の関心事 (画面が知る必要なし)
  const [collapsed, setCollapsed] = useState(false);
  const onToggleCollapse = () => setCollapsed((v) => !v);
  const [stepsExpanded, setStepsExpanded] = useState(false);

  // instruction が新しくなったら自動展開 (ステップ進行時)
  useEffect(() => {
    setCollapsed(false);
  }, [instruction]);

  if (!instruction) return null;

  return (
    <View style={styles.container}>
      {/* Header */}
      <Pressable style={styles.header} onPress={onToggleCollapse}>
        <View style={styles.stepBadge}>
          <Text style={styles.stepBadgeText}>
            {currentStep}/{totalSteps}
          </Text>
        </View>

        <Text style={styles.title} numberOfLines={collapsed ? 1 : undefined}>
          {instruction.replace(/[#*_`~>\-]/g, "").trim()}
        </Text>

        {totalSteps > 0 && (
          <Pressable
            style={styles.listBtn}
            onPress={() => setStepsExpanded((v) => !v)}
          >
            <Feather
              name={stepsExpanded ? "chevron-up" : "list"}
              size={16}
              color="#666"
            />
          </Pressable>
        )}
      </Pressable>

      {/* Step list */}
      {stepsExpanded && (
        <ScrollView style={styles.stepList}>
          {steps.map((s) => (
            <View key={s.step_number} style={styles.stepRow}>
              <View
                style={[
                  styles.stepDot,
                  { backgroundColor: s.step_number === currentStep ? ACCENT : "#ccc" },
                ]}
              />
              <Text
                style={[
                  styles.stepText,
                  s.step_number === currentStep && styles.stepTextActive,
                ]}
                numberOfLines={1}
              >
                {s.text}
              </Text>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Body (markdown) */}
      {!collapsed && !stepsExpanded && (
        <ScrollView style={styles.body}>
          <Markdown style={mdStyles}>{instruction}</Markdown>
        </ScrollView>
      )}
    </View>
  );
}

const mdStyles = StyleSheet.create({
  body: { color: "#1A1A1A", fontSize: 13, lineHeight: 18 },
  heading2: { fontSize: 14, fontWeight: "700", marginBottom: 4 },
});

const styles = StyleSheet.create({
  container: {
    backgroundColor: "rgba(255,255,255,0.92)",
    borderRadius: 12,
    padding: 8,
    maxHeight: 140,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  stepBadge: {
    backgroundColor: ACCENT,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  stepBadgeText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
  },
  title: {
    flex: 1,
    fontSize: 12,
    fontWeight: "600",
    color: "#1A1A1A",
  },
  listBtn: {
    padding: 4,
  },
  stepList: {
    marginTop: 4,
    maxHeight: 80,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 3,
  },
  stepDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  stepText: {
    fontSize: 11,
    color: "#666",
    flex: 1,
  },
  stepTextActive: {
    color: "#1A1A1A",
    fontWeight: "600",
  },
  body: {
    marginTop: 4,
    maxHeight: 80,
  },
});
