import { useState } from "react";
import {
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { View, Text } from "@tamagui/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather, MaterialCommunityIcons } from "@expo/vector-icons";
import { MODES, type ModeKey } from "@/constants/modes";
import { useApiContext } from "@/contexts/ApiContext";
import { generatePlan } from "@/hooks/useJudgeApi";
import type { GuideModeType } from "@/constants/Config";
import type { Plan } from "@/types/plan";

export default function GoalScreen() {
  const { mode } = useLocalSearchParams<{ mode: string }>();
  const router = useRouter();
  const { apiUrl } = useApiContext();
  const [goal, setGoal] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedPlan, setGeneratedPlan] = useState<Plan | null>(null);

  const config = MODES[(mode as ModeKey) ?? "diy"] ?? MODES.diy;

  const handleGenerate = async () => {
    if (!goal.trim()) return;

    setIsGenerating(true);
    setError(null);
    setGeneratedPlan(null);

    try {
      const plan = await generatePlan(
        apiUrl,
        goal.trim(),
        (mode ?? "diy") as GuideModeType
      );
      setGeneratedPlan(plan);
    } catch (err) {
      console.warn("[GoalScreen] Plan generation failed:", err);
      setError("プラン生成に失敗しました");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleStartWithPlan = () => {
    if (!generatedPlan) return;
    router.push(
      `/guide?mode=${mode}&goal=${encodeURIComponent(goal.trim())}&planId=${generatedPlan.source_id}`
    );
  };

  const handleStartManual = () => {
    router.push(
      `/guide?mode=${mode}&goal=${encodeURIComponent(goal.trim())}`
    );
  };

  const handleRegenerate = () => {
    setGeneratedPlan(null);
    handleGenerate();
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View flex={1} backgroundColor="$background" paddingHorizontal="$4">
          {/* Header */}
          <View
            flexDirection="row"
            alignItems="center"
            paddingTop="$4"
            paddingBottom="$2"
            gap="$2"
          >
            <Pressable onPress={() => { setGeneratedPlan(null); router.back(); }}>
              <Feather name="chevron-left" size={28} color="#333" />
            </Pressable>
            <Text fontSize="$7" fontWeight="700" color="$color">
              {config.labelWithMode}
            </Text>
          </View>

          {/* Plan confirmation view */}
          {generatedPlan ? (
            <View flex={1} paddingBottom="$4">
              <Text fontSize="$5" fontWeight="600" color="$color" paddingVertical="$3">
                生成されたプラン ({generatedPlan.steps.length}ステップ)
              </Text>

              <ScrollView style={styles.planList} showsVerticalScrollIndicator>
                {generatedPlan.steps.map((step) => (
                  <View key={step.step_number} style={styles.planStep}>
                    <View
                      width={28}
                      height={28}
                      borderRadius={14}
                      backgroundColor={config.color}
                      alignItems="center"
                      justifyContent="center"
                    >
                      <Text fontSize="$2" fontWeight="700" color="#fff">
                        {step.step_number}
                      </Text>
                    </View>
                    <View flex={1}>
                      <Text fontSize="$3" color="#1A1A1A" fontWeight="500">
                        {step.text}
                      </Text>
                      {step.visual_marker ? (
                        <Text fontSize="$2" color="#888" marginTop="$1">
                          ✓ {step.visual_marker}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))}
              </ScrollView>

              {/* Action buttons */}
              <View gap="$3" paddingTop="$3">
                <Pressable
                  onPress={handleStartWithPlan}
                  style={({ pressed }) => [
                    styles.startButton,
                    { backgroundColor: config.color },
                    pressed && styles.startPressed,
                  ]}
                >
                  <Feather name="play" size={20} color="#fff" />
                  <Text color="#fff" fontWeight="700" fontSize="$5">
                    このプランで開始
                  </Text>
                </Pressable>

                <View flexDirection="row" gap="$3">
                  <Pressable
                    onPress={handleRegenerate}
                    disabled={isGenerating}
                    style={({ pressed }) => [
                      styles.secondaryButton,
                      { borderColor: config.color },
                      pressed && styles.startPressed,
                    ]}
                  >
                    <Feather name="refresh-cw" size={16} color={config.color} />
                    <Text color={config.color} fontWeight="600" fontSize="$3">
                      再生成
                    </Text>
                  </Pressable>

                  <Pressable
                    onPress={handleStartManual}
                    style={({ pressed }) => [
                      styles.secondaryButton,
                      { borderColor: "#999" },
                      pressed && styles.startPressed,
                    ]}
                  >
                    <Feather name="camera" size={16} color="#999" />
                    <Text color="#999" fontWeight="600" fontSize="$3">
                      手動モード
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          ) : (
            /* Goal input view */
            <View flex={1} justifyContent="center" gap="$6" paddingBottom="$8">
              {/* Mode Icon */}
              <View alignItems="center">
                <View
                  width={80}
                  height={80}
                  borderRadius={40}
                  backgroundColor={config.color + "15"}
                  alignItems="center"
                  justifyContent="center"
                >
                  <MaterialCommunityIcons
                    name={config.icon}
                    size={40}
                    color={config.color}
                  />
                </View>
              </View>

              <Text
                textAlign="center"
                fontSize="$6"
                fontWeight="600"
                color="$color"
              >
                何をしますか？
              </Text>

              <View paddingHorizontal="$2">
                <TextInput
                  style={[styles.input, { borderColor: config.color + "40" }]}
                  placeholder={config.goalPlaceholder}
                  placeholderTextColor="#999"
                  value={goal}
                  onChangeText={setGoal}
                  multiline
                  autoFocus
                  returnKeyType="done"
                  blurOnSubmit
                  editable={!isGenerating}
                />
              </View>

              {error && (
                <View paddingHorizontal="$2">
                  <Text color="#EF4444" fontSize="$3" textAlign="center">
                    {error}
                  </Text>
                </View>
              )}

              <View paddingHorizontal="$2" gap="$3">
                <Pressable
                  onPress={handleGenerate}
                  disabled={!goal.trim() || isGenerating}
                  style={({ pressed }) => [
                    styles.startButton,
                    { backgroundColor: config.color },
                    (!goal.trim() || isGenerating) && styles.startDisabled,
                    pressed && styles.startPressed,
                  ]}
                >
                  {isGenerating ? (
                    <>
                      <ActivityIndicator color="#fff" size="small" />
                      <Text color="#fff" fontWeight="700" fontSize="$5">
                        プラン生成中...
                      </Text>
                    </>
                  ) : (
                    <>
                      <Feather name="zap" size={20} color="#fff" />
                      <Text color="#fff" fontWeight="700" fontSize="$5">
                        プランを生成
                      </Text>
                    </>
                  )}
                </Pressable>

                <Pressable
                  onPress={handleStartManual}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    { borderColor: "#999" },
                    pressed && styles.startPressed,
                  ]}
                >
                  <Feather name="camera" size={16} color="#666" />
                  <Text color="#666" fontWeight="600" fontSize="$3">
                    プランなしで開始
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#F8F9FA",
  },
  input: {
    backgroundColor: "#fff",
    borderRadius: 16,
    borderWidth: 1.5,
    paddingHorizontal: 20,
    paddingVertical: 16,
    fontSize: 17,
    color: "#1A1A1A",
    minHeight: 56,
    maxHeight: 120,
  },
  startButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    borderRadius: 16,
  },
  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  startDisabled: {
    opacity: 0.4,
  },
  startPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.98 }],
  },
  planList: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
  },
  planStep: {
    flexDirection: "row",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E5E5E5",
  },
});
