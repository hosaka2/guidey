import { useCallback, useEffect, useRef, useState } from "react";
import {
  StyleSheet,
  Pressable,
  ScrollView,
  Dimensions,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { View, Text } from "@tamagui/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Speech from "expo-speech";
import Markdown from "react-native-markdown-display";
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
} from "react-native-reanimated";

import { CameraView, CameraViewHandle } from "@/components/CameraView";
import { useGuideApi } from "@/hooks/useGuideApi";
import { useAutonomousLoop } from "@/hooks/useAutonomousLoop";
import { useAgentState, type SpeakType } from "@/hooks/useAgentState";
import { callChat } from "@/hooks/useJudgeApi";
import {
  useSpeechRecognition,
  type VoiceIntent,
} from "@/hooks/useSpeechRecognition";
import { useApiContext } from "@/contexts/ApiContext";
import type { PlanStep } from "@/types/plan";
import type { Block } from "@/types/blocks";
import { BlockRenderer } from "@/components/BlockRenderer";
import { FeedbackButtons } from "@/components/FeedbackButtons";
import { StepFeedback } from "@/components/StepFeedback";

const REF_BASE_W = 120;
const REF_BASE_H = 90;
const REF_MIN_SCALE = 1;
const REF_MAX_SCALE = 3;

export default function GuideScreen() {
  const { goal, planId } = useLocalSearchParams<{
    goal: string;
    planId: string;
  }>();
  const router = useRouter();
  const cameraRef = useRef<CameraViewHandle>(null);
  const { apiUrl } = useApiContext();
  const {
    analyzeStream,
    isLoading,
    lastInstruction,
    setLastInstruction,
    error,
    referenceImageUrl,
    setReferenceImageUrl,
    currentStep,
    setCurrentStep,
    totalSteps,
    setTotalSteps,
    steps,
    setSteps,
  } = useGuideApi();

  const [instructionCollapsed, setInstructionCollapsed] = useState(false);
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [activeBlocks, setActiveBlocks] = useState<Block[]>([]);
  const [showStepFeedback, setShowStepFeedback] = useState(false);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInputValue, setTextInputValue] = useState("");
  const maxInstructionHeight = Dimensions.get("window").height * 0.15;

  // Pinch-to-zoom for reference image
  const refScale = useSharedValue(1);
  const refSavedScale = useSharedValue(1);

  const pinchGesture = Gesture.Pinch()
    .onUpdate((e) => {
      refScale.value = Math.min(
        REF_MAX_SCALE,
        Math.max(REF_MIN_SCALE, refSavedScale.value * e.scale)
      );
    })
    .onEnd(() => {
      refSavedScale.value = refScale.value;
    });

  const refAnimatedStyle = useAnimatedStyle(() => ({
    width: REF_BASE_W * refScale.value,
    height: REF_BASE_H * refScale.value,
    borderRadius: 8,
  }));

  // Pinch-to-resize for blocks card
  const screenH = Dimensions.get("window").height;
  const BLOCKS_MAX_H = screenH * 0.4;

  // Voice trigger: ref で循環参照を回避
  const handleCaptureRef = useRef<() => void>(() => {});
  const lastInstructionRef = useRef<string | null>(null);
  lastInstructionRef.current = lastInstruction;
  // 自律モード関数もrefで参照 (宣言順序の問題回避)
  const advanceStepRef = useRef<() => void>(() => {});
  const goBackStepRef = useRef<() => void>(() => {});
  const toggleAutonomousRef = useRef<() => void>(() => {});
  const pauseForTTSRef = useRef<() => void>(() => {});
  const resumeAfterTTSRef = useRef<() => void>(() => {});
  const agentSpeakRef = useRef<(msg: string, src: "periodic" | "user_action", speakType?: SpeakType) => boolean>(() => false);
  const sendChatRef = useRef<(msg: string) => void>(() => {});
  const isAutonomousRef = useRef(false);

  const handleVoiceTrigger = useCallback(
    (action: VoiceIntent, raw?: string) => {
      switch (action) {
        case "capture":
          if (!isLoading) handleCaptureRef.current?.();
          break;
        case "next_step":
          advanceStepRef.current();
          break;
        case "previous_step":
          goBackStepRef.current();
          break;
        case "skip":
          advanceStepRef.current();
          break;
        case "stop":
          Speech.stop();
          break;
        case "pause":
          if (isAutonomousRef.current) toggleAutonomousRef.current();
          break;
        case "resume":
          if (!isAutonomousRef.current && planId) toggleAutonomousRef.current();
          break;
        case "repeat":
          if (lastInstructionRef.current) {
            const plain = lastInstructionRef.current.replace(/[#*_`~>\-]/g, "").replace(/\n+/g, "。");
            agentSpeakRef.current(plain, "user_action", "respond");
          }
          break;
        case "question":
        case "report_status":
        case "request_help":
          if (!isLoading && raw) sendChatRef.current(raw);
          break;
        case "feedback_positive":
        case "feedback_negative":
          sendFeedback(
            action === "feedback_positive" ? "positive" : "negative",
            "voice",
            raw,
          );
          break;
        default:
          // キーワードにマッチしない発話 → chat に送る
          if (raw && raw.length >= 4) {
            sendChatRef.current(raw);
          }
          break;
      }
    },
    [isLoading, planId]
  );

  const { isListening, pauseForTTS, resumeAfterTTS, stopListening } =
    useSpeechRecognition(handleVoiceTrigger, voiceEnabled);

  // ref同期 (pauseForTTS/resumeAfterTTS)
  pauseForTTSRef.current = pauseForTTS;
  resumeAfterTTSRef.current = resumeAfterTTS;

  // --- SharedState: 競合管理 ---
  const {
    acquireLock,
    releaseLock,
    speak: agentSpeak,
    registerTTSCallbacks,
    enterConversation,
    exitConversation,
  } = useAgentState();

  // ref同期 (agentSpeak — 宣言順序の問題回避)
  agentSpeakRef.current = agentSpeak;

  // TTS ↔ 音声認識の連携を登録
  useEffect(() => {
    registerTTSCallbacks(pauseForTTS, resumeAfterTTS);
  }, [registerTTSCallbacks, pauseForTTS, resumeAfterTTS]);

  // --- フィードバック ---
  const sendFeedback = useCallback(
    (sentiment: string, source: string, raw?: string) => {
      fetch(`${apiUrl}/guide/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_type: "utterance",
          sentiment,
          source,
          target_content: lastInstructionRef.current?.slice(0, 100) || "",
          raw_content: raw || "",
          step_index: currentStep,
        }),
      }).catch((err) => console.warn("[Feedback] send failed:", err));
    },
    [apiUrl, currentStep]
  );

  const showBlocks = useCallback((blocks: Block[]) => {
    if (blocks.length > 0) {
      setActiveBlocks((prev) => [...prev, ...blocks].slice(-10));
    }
  }, []);

  const handleStepAdvanced = useCallback(
    (step: PlanStep, message: string, blocks: Block[] = []) => {
      console.log(`[Guide] ★ onStepAdvanced: step=${step.step_number} blocks=${blocks.length}`);

      // 指示カードを更新
      setLastInstruction(`## ステップ ${step.step_number}\n\n${step.text}`);
      setInstructionCollapsed(false);

      // ステップ情報を更新
      setCurrentStep(step.step_number);

      // お手本画像を更新
      if (step.frame_url) {
        setReferenceImageUrl(`${apiUrl}${step.frame_url}`);
      }

      // ステップフィードバック表示
      setShowStepFeedback(true);

      // UIブロック表示
      showBlocks(blocks);

      // TTS読み上げ (agentSpeak で競合管理)
      const prefix = message ? `${message}。` : "";
      const plain = `${prefix}ステップ${step.step_number}。${step.text}`;
      agentSpeak(plain, "periodic", "transition");
    },
    [apiUrl, agentSpeak, setLastInstruction, setCurrentStep, setReferenceImageUrl, showBlocks]
  );

  const handleAnomaly = useCallback(
    (message: string, blocks: Block[] = []) => {
      // 指示カードは変更しない (現在のステップ指示を維持)
      // anomaly はブロックカード + TTS で通知
      const anomalyBlocks: Block[] = [
        { type: "alert", message: message || "何かお困りですか？", severity: "warning" },
        ...blocks,
      ];
      showBlocks(anomalyBlocks);

      // warn で割り込み可能
      agentSpeak(message || "何かお困りですか？", "periodic", "warn");
    },
    [agentSpeak, showBlocks]
  );

  // --- Proactive message: AIが自発的に声をかける ---
  const handleProactiveMessage = useCallback(
    (message: string, blocks: Block[] = []) => {
      console.log(`[Guide] 💬 proactive: ${message.slice(0, 40)}`);

      // ブロックカードに表示 (AI発言として)
      const aiBlocks: Block[] = [
        { type: "text", content: message, style: "normal" },
        ...blocks,
      ];
      showBlocks(aiBlocks);

      // advise で控えめに (会話モード中は抑制される)
      agentSpeak(message, "periodic", "advise");
    },
    [agentSpeak, showBlocks]
  );

  const {
    isActive: isAutonomous,
    plan: autonomousPlan,
    currentStepIndex: autoStepIndex,
    captureIntervalMs,
    toggleAutonomous,
    advanceStep,
    goBackStep,
  } = useAutonomousLoop({
    cameraRef,
    apiUrl,
    planSourceId: planId ?? "",
    acquireLock,
    releaseLock,
    onStepAdvanced: handleStepAdvanced,
    onAnomaly: handleAnomaly,
    onProactiveMessage: handleProactiveMessage,
  });

  // ref同期 (自律モード関数)
  advanceStepRef.current = advanceStep;
  goBackStepRef.current = goBackStep;
  toggleAutonomousRef.current = toggleAutonomous;
  isAutonomousRef.current = isAutonomous;

  // 自律モード開始時: プランの最初のステップを表示
  useEffect(() => {
    if (autonomousPlan && autonomousPlan.steps.length > 0) {
      const firstStep = autonomousPlan.steps[0];
      setLastInstruction(`## ステップ ${firstStep.step_number}\n\n${firstStep.text}`);
      setCurrentStep(firstStep.step_number);
      setTotalSteps(autonomousPlan.steps.length);
      setSteps(
        autonomousPlan.steps.map((s) => ({
          step_number: s.step_number,
          text: s.text,
          frame_url: s.frame_url,
        }))
      );
      if (firstStep.frame_url) {
        setReferenceImageUrl(`${apiUrl}${firstStep.frame_url}`);
      }
    }
  }, [autonomousPlan, apiUrl, setLastInstruction, setCurrentStep, setTotalSteps, setSteps, setReferenceImageUrl]);

  // 新しい解析が始まったら展開
  useEffect(() => {
    if (isLoading) setInstructionCollapsed(false);
  }, [isLoading]);

  // 共通: LLM応答をブロックカードに表示 + TTS
  const handleLLMResponse = useCallback(
    (fullText: string | null, _triggerWord: string) => {
      if (fullText) {
        showBlocks([{ type: "text", content: fullText, style: "normal" } as Block]);
        agentSpeak(fullText, "user_action", "respond");
      }
    },
    [agentSpeak, showBlocks]
  );

  // /guide/chat 経由でユーザー対話 (統一パイプライン user_action)
  const sendChat = useCallback(async (userMsg: string, withImage: boolean = true) => {
    enterConversation();
    acquireLock();

    showBlocks([{ type: "text", content: `💬 ${userMsg}`, style: "emphasis" } as Block]);

    const uri = withImage ? await cameraRef.current?.takePicture() : null;
    try {
      // session_id + message のみ。コンテキストは BE が管理。
      const result = await callChat(
        apiUrl, userMsg, uri ?? null,
        autonomousPlan?.session_id ?? "",
      );

      const blocks: Block[] = result.blocks || [];
      if (result.message) {
        blocks.unshift({ type: "text", content: result.message, style: "normal" });
      }
      showBlocks(blocks);

      if (result.message) {
        agentSpeak(result.message, "user_action", "respond");
      }
    } catch (err) {
      console.warn("[Chat] error:", err);
      showBlocks([{ type: "alert", message: "エラーが発生しました", severity: "warning" } as Block]);
    } finally {
      releaseLock();
      setTimeout(() => exitConversation(), 3000);
    }
  }, [apiUrl, autonomousPlan, agentSpeak, showBlocks, acquireLock, releaseLock, enterConversation, exitConversation]);

  const handleCapture = useCallback(async () => {
    showBlocks([{ type: "text", content: "📷 解析中...", style: "emphasis" } as Block]);

    if (planId) {
      // プランあり → /chat 経由 (tool calling)
      await sendChat("教えて");
    } else {
      // プランなし → 従来の analyzeStream
      const uri = await cameraRef.current?.takePicture();
      if (!uri) return;
      pauseForTTS();
      const fullText = await analyzeStream(uri, "教えて", goal ?? "");
      handleLLMResponse(fullText, "教えて");
    }
  }, [planId, sendChat, goal, analyzeStream, pauseForTTS, handleLLMResponse, showBlocks]);

  handleCaptureRef.current = handleCapture;
  sendChatRef.current = sendChat;

  const handleTextSubmit = useCallback(async () => {
    const text = textInputValue.trim();
    if (!text) return;
    setShowTextInput(false);
    setTextInputValue("");
    await sendChat(text);
  }, [textInputValue, sendChat]);

  // 画面を離れたら読み上げ+音声認識停止
  useEffect(() => {
    return () => {
      Speech.stop();
      stopListening();
    };
  }, [stopListening]);

  return (
    <GestureHandlerRootView style={styles.container}>
      {/* Header */}
      <SafeAreaView edges={["top"]} style={styles.headerSafe}>
        <View
          flexDirection="row"
          paddingHorizontal="$4"
          paddingVertical="$2"
          alignItems="center"
          gap="$2"
        >
          <Pressable onPress={() => router.back()}>
            <Feather name="chevron-left" size={28} color="#fff" />
          </Pressable>
          <View flex={1}>
            <Text color="#fff" fontSize="$6" fontWeight="700" numberOfLines={1}>
              Guidey
            </Text>
            {goal ? (
              <Text
                color="rgba(255,255,255,0.7)"
                fontSize="$3"
                numberOfLines={1}
              >
                {goal}
              </Text>
            ) : null}
          </View>
          {isAutonomous && autonomousPlan ? (
            <View style={styles.autonomousHeaderBadge}>
              <View style={styles.pulseDot} />
              <Text color="#fff" fontSize="$1" fontWeight="600">
                自律モード {autoStepIndex + 1}/{autonomousPlan.steps.length}
              </Text>
            </View>
          ) : null}
        </View>
      </SafeAreaView>

      {/* Camera */}
      <View style={styles.camera}>
        <CameraView ref={cameraRef} />
      </View>

      {/* Reference image (top-right, pinch to zoom) */}
      {referenceImageUrl && (
        <View style={styles.referenceContainer}>
          <GestureDetector gesture={pinchGesture}>
            <Animated.View style={styles.referenceBg}>
              <Text style={styles.referenceLabel}>お手本</Text>
              <Animated.Image
                source={{ uri: referenceImageUrl }}
                style={refAnimatedStyle}
                resizeMode="cover"
              />
            </Animated.View>
          </GestureDetector>
        </View>
      )}

      {/* Instruction card (常時固定: ステップ情報 + Markdown指示) */}
      {lastInstruction && (
        <View style={styles.instructionContainer}>
          <View
            backgroundColor="rgba(255,255,255,0.95)"
            borderRadius="$4"
            marginHorizontal="$4"
            overflow="hidden"
          >
            {/* Header: tap to collapse/expand */}
            <Pressable
              onPress={() => setInstructionCollapsed((v) => !v)}
              style={styles.instructionHeader}
            >
              <View flexDirection="row" alignItems="center" gap="$2" flex={1}>
                {currentStep != null && totalSteps != null && (
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      setStepsExpanded((v) => !v);
                    }}
                    hitSlop={8}
                  >
                    <View
                      flexDirection="row"
                      alignItems="center"
                      gap="$1"
                      backgroundColor={"#FF6B35"}
                      borderRadius="$2"
                      paddingHorizontal="$2"
                      paddingVertical="$1"
                    >
                      <Text fontSize="$2" fontWeight="700" color="#fff">
                        {currentStep}/{totalSteps}
                      </Text>
                      <Feather
                        name={stepsExpanded ? "list" : "list"}
                        size={12}
                        color="#fff"
                      />
                    </View>
                  </Pressable>
                )}
                {instructionCollapsed && lastInstruction && (
                  <Text
                    fontSize="$3"
                    color="#666"
                    numberOfLines={1}
                    flex={1}
                  >
                    {lastInstruction.replace(/[#*_`~>\-]/g, "").trim()}
                  </Text>
                )}
              </View>
              <Feather
                name={instructionCollapsed ? "chevron-up" : "chevron-down"}
                size={18}
                color="#999"
              />
            </Pressable>

            {/* Steps list */}
            {stepsExpanded && steps.length > 0 && (
              <ScrollView
                style={{ maxHeight: maxInstructionHeight }}
                contentContainerStyle={styles.stepsListBody}
                showsVerticalScrollIndicator
              >
                {steps.map((s) => {
                  const isActive = s.step_number === currentStep;
                  return (
                    <View
                      key={s.step_number}
                      flexDirection="row"
                      gap="$2"
                      paddingVertical="$1.5"
                      opacity={isActive ? 1 : 0.6}
                    >
                      <View
                        width={24}
                        height={24}
                        borderRadius={12}
                        backgroundColor={isActive ? "#FF6B35" : "#ccc"}
                        alignItems="center"
                        justifyContent="center"
                      >
                        <Text
                          fontSize="$2"
                          fontWeight="700"
                          color="#fff"
                        >
                          {s.step_number}
                        </Text>
                      </View>
                      <Text
                        fontSize="$3"
                        color="#1A1A1A"
                        flex={1}
                        fontWeight={isActive ? "700" : "400"}
                      >
                        {s.text}
                      </Text>
                    </View>
                  );
                })}
              </ScrollView>
            )}

            {/* Body: scrollable, height-limited */}
            {!instructionCollapsed && !stepsExpanded && (
              <ScrollView
                style={{ maxHeight: maxInstructionHeight }}
                contentContainerStyle={styles.instructionBody}
                showsVerticalScrollIndicator
              >
                <Markdown style={mdStyles}>{lastInstruction}</Markdown>
              </ScrollView>
            )}
          </View>
        </View>
      )}

      {/* Dynamic Blocks (chat-like) */}
      {activeBlocks.length > 0 && (
        <View style={[styles.blocksContainer, { maxHeight: BLOCKS_MAX_H }]}>
              <ScrollView
                contentContainerStyle={styles.blocksContent}
                showsVerticalScrollIndicator={false}
              >
                {activeBlocks.map((block, i) => {
                  const isLatest = i === activeBlocks.length - 1;
                  return (
                    <View
                      key={`block-${i}`}
                      opacity={isLatest ? 1 : 0.5}
                      scale={isLatest ? 1 : 0.92}
                    >
                      <BlockRenderer blocks={[block]} />
                      {/* 最新ブロックにフィードバック */}
                      {isLatest && !isLoading && !showStepFeedback && (
                        <FeedbackButtons
                          onFeedback={(sentiment) => sendFeedback(sentiment, "tap")}
                        />
                      )}
                      {isLatest && showStepFeedback && (
                        <StepFeedback
                          onFeedback={(sentiment) => {
                            sendFeedback(sentiment, "tap");
                            setShowStepFeedback(false);
                          }}
                        />
                      )}
                    </View>
                  );
                })}
              </ScrollView>
        </View>
      )}

      {/* Error */}
      {error && (
        <View style={styles.errorContainer}>
          <View
            backgroundColor="rgba(239,68,68,0.95)"
            borderRadius="$4"
            padding="$3"
            marginHorizontal="$4"
          >
            <Text fontSize="$3" color="#fff">
              {error}
            </Text>
          </View>
        </View>
      )}

      {/* (autonomous indicator moved into header) */}

      {/* Capture button + Voice indicator + Autonomous toggle */}
      <SafeAreaView edges={["bottom"]} style={styles.bottomSafe}>
        <View alignItems="center" paddingBottom="$4" gap="$2">
          {/* Voice status */}
          <Pressable
            onPress={() => setVoiceEnabled((v) => !v)}
            style={styles.voiceIndicator}
          >
            <Feather
              name={voiceEnabled ? "mic" : "mic-off"}
              size={18}
              color={isListening ? "#4CAF50" : "#999"}
            />
            <Text
              color={isListening ? "#4CAF50" : "#999"}
              fontSize="$2"
              fontWeight="600"
            >
              {isListening
                ? "「教えて」で撮影"
                : voiceEnabled
                  ? "接続中..."
                  : "音声OFF"}
            </Text>
          </Pressable>

          <View flexDirection="row" gap="$3" alignItems="center">
            {/* Text input button */}
            <Pressable
              onPress={() => setShowTextInput(true)}
              style={({ pressed }) => [
                styles.autoButton,
                pressed && styles.capturePressed,
              ]}
            >
              <Feather name="edit-2" size={22} color="#fff" />
            </Pressable>

            {/* Manual capture button */}
            <Pressable
              onPress={handleCapture}
              disabled={isLoading}
              style={({ pressed }) => [
                styles.captureButton,
                isLoading && styles.captureDisabled,
                pressed && styles.capturePressed,
              ]}
            >
              <Feather name="camera" size={24} color="#fff" />
              <Text color="#fff" fontWeight="700" fontSize="$4">
                {isLoading ? "解析中..." : "撮影して聞く"}
              </Text>
            </Pressable>

            {/* Autonomous toggle */}
            {planId ? (
              <Pressable
                onPress={toggleAutonomous}
                style={({ pressed }) => [
                  styles.autoButton,
                  isAutonomous && styles.autoButtonActive,
                  pressed && styles.capturePressed,
                ]}
              >
                <Feather
                  name={isAutonomous ? "pause" : "play"}
                  size={24}
                  color="#fff"
                />
              </Pressable>
            ) : null}
          </View>
        </View>
      </SafeAreaView>
      {/* Text Input Modal */}
      <Modal visible={showTextInput} transparent animationType="slide">
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setShowTextInput(false)} />
          <View style={styles.modalContent}>
            <View flexDirection="row" alignItems="center" gap="$2">
              <TextInput
                style={styles.chatInput}
                placeholder="質問や指示を入力..."
                placeholderTextColor="#999"
                value={textInputValue}
                onChangeText={setTextInputValue}
                autoFocus
                returnKeyType="send"
                onSubmitEditing={handleTextSubmit}
              />
              <Pressable
                onPress={handleTextSubmit}
                disabled={!textInputValue.trim() || isLoading}
                style={({ pressed }) => [
                  styles.sendButton,
                  (!textInputValue.trim() || isLoading) && styles.captureDisabled,
                  pressed && styles.capturePressed,
                ]}
              >
                <Feather name="send" size={20} color="#fff" />
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </GestureHandlerRootView>
  );
}

const mdStyles = StyleSheet.create({
  body: {
    fontSize: 15,
    lineHeight: 24,
    color: "#1A1A1A",
  },
  heading1: {
    fontSize: 20,
    fontWeight: "700",
    color: "#1A1A1A",
    marginTop: 8,
    marginBottom: 4,
  },
  heading2: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1A1A",
    marginTop: 8,
    marginBottom: 4,
  },
  heading3: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1A1A1A",
    marginTop: 6,
    marginBottom: 2,
  },
  strong: {
    fontWeight: "700",
  },
  bullet_list: {
    marginTop: 4,
    marginBottom: 4,
  },
  ordered_list: {
    marginTop: 4,
    marginBottom: 4,
  },
  list_item: {
    marginBottom: 4,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 8,
  },
  code_inline: {
    backgroundColor: "#F0F0F0",
    borderRadius: 4,
    paddingHorizontal: 4,
    fontSize: 14,
    fontFamily: "Courier",
  },
  fence: {
    backgroundColor: "#F0F0F0",
    borderRadius: 8,
    padding: 10,
    marginVertical: 6,
    fontSize: 13,
    fontFamily: "Courier",
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  headerSafe: {
    backgroundColor: "rgba(0,0,0,0.5)",
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  camera: {
    flex: 1,
  },
  referenceContainer: {
    position: "absolute",
    top: 120,
    right: 16,
    zIndex: 10,
  },
  referenceBg: {
    backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 12,
    padding: 6,
    alignItems: "center",
  },
  referenceLabel: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 4,
  },
  instructionContainer: {
    position: "absolute" as const,
    bottom: 120,
    left: 0,
    right: 0,
    zIndex: 8,
  },
  instructionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  instructionBody: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  stepsListBody: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  blocksContainer: {
    position: "absolute" as const,
    bottom: 185,
    left: 12,
    right: 12,
    zIndex: 6,
  },
  blocksContent: {
    paddingHorizontal: 10,
    paddingBottom: 8,
    gap: 6,
  },
  errorContainer: {
    position: "absolute",
    bottom: 120,
    left: 0,
    right: 0,
  },
  bottomSafe: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
  },
  voiceIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  captureButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#2F95DC",
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 32,
  },
  captureDisabled: {
    opacity: 0.5,
  },
  capturePressed: {
    opacity: 0.8,
    transform: [{ scale: 0.96 }],
  },
  autoButton: {
    backgroundColor: "rgba(255,255,255,0.2)",
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  autoButtonActive: {
    backgroundColor: "#4CAF50",
  },
  autonomousHeaderBadge: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 4,
    backgroundColor: "#4CAF50",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  pulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#fff",
  },
  modalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  modalBackdrop: {
    flex: 1,
  },
  modalContent: {
    backgroundColor: "#fff",
    paddingHorizontal: 16,
    paddingVertical: 12,
    paddingBottom: 32,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  chatInput: {
    flex: 1,
    backgroundColor: "#F0F0F0",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    color: "#1A1A1A",
  },
  sendButton: {
    backgroundColor: "#2F95DC",
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
});
