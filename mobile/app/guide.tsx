import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Speech from "expo-speech";
import * as ScreenOrientation from "expo-screen-orientation";

import { BottomBar } from "@/components/BottomBar";
import { CameraViewHandle } from "@/components/CameraView";
import { InstructionCard } from "@/components/InstructionCard";
import { GuideLayout } from "@/components/layout";
import { View } from "@/components/ui";
import { useApiContext } from "@/contexts/ApiContext";
import { useAutonomousLoop } from "@/features/autonomous";
import { ChatInput, useChat } from "@/features/chat";
import { useFeedback } from "@/features/feedback";
import { usePlan } from "@/features/plan";
import { useSpeechRecognition, useVoiceIntents } from "@/features/voice";
import { useAgentState, useBlockRouter } from "@/lib/hooks";
import type { Block, PlanStep } from "@/lib/types";

/**
 * プラン進行画面。features を composition するだけのオーケストレータ。
 *
 * 責務:
 *   - URL パラメータ (planId) からプラン取得
 *   - autonomous ループ + chat を並行運用 (lock で排他)
 *   - 音声 intent → autonomous / chat / feedback に dispatch
 *   - InstructionCard の表示 + TTS 競合管理 (useAgentState)
 */
export default function GuideScreen() {
  const { planId } = useLocalSearchParams<{ planId: string }>();
  const router = useRouter();
  const { apiUrl } = useApiContext();
  const cameraRef = useRef<CameraViewHandle>(null);

  // --- UI state ---
  const [activeBlocks, setActiveBlocks] = useState<Block[]>([]);
  const [lastInstruction, setLastInstruction] = useState<string | null>(null);
  const [isAutonomous, setIsAutonomous] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [showInput, setShowInput] = useState(false);
  const [inputValue, setInputValue] = useState("");

  // --- 横向きロック ---
  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, []);

  // --- プラン (session_id は plan.session_id) ---
  const { plan } = usePlan(planId ?? null);

  // 初回: 先頭ステップを InstructionCard にセット + お手本画像を blocks に追加
  useEffect(() => {
    if (!plan || plan.steps.length === 0) return;
    const first = plan.steps[0];
    setLastInstruction(`## ステップ ${first.step_number}\n\n${first.text}`);
    if (first.frame_url) {
      appendBlocks([{
        type: "image",
        url: `${apiUrl}${first.frame_url}`,
        caption: `ステップ${first.step_number} お手本`,
      }]);
    }
    // 自動開始 (autonomous を on)
    setIsAutonomous(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, apiUrl]);

  // --- ブロック表示 ---
  const { textBlocks, timerBlocks, mediaBlocks } = useBlockRouter(activeBlocks);
  const appendBlocks = useCallback((blocks: Block[]) => {
    if (blocks.length === 0) return;
    setActiveBlocks((prev) => [...prev, ...blocks].slice(-10));
  }, []);

  // --- エージェント共有状態 (lock + TTS 競合) ---
  const {
    acquireLock, releaseLock,
    speak, registerTTSCallbacks,
    enterConversation, exitConversation,
  } = useAgentState();

  // --- Chat ---
  const { sendChat } = useChat({
    cameraRef,
    sessionId: plan?.session_id ?? "",
    onBlocks: appendBlocks,
    onSpeak: (msg, type) => speak(msg, "user_action", type),
    onEnter: enterConversation,
    onExit: exitConversation,
    acquireLock,
    releaseLock,
  });

  // --- Autonomous ループ (steps 変わったら再作成) ---
  const handleStepAdvanced = useCallback(
    (step: PlanStep, message: string, blocks: Block[]) => {
      setLastInstruction(`## ステップ ${step.step_number}\n\n${step.text}`);
      if (step.frame_url) {
        appendBlocks([{
          type: "image",
          url: `${apiUrl}${step.frame_url}`,
          caption: `ステップ${step.step_number} お手本`,
        }]);
      }
      appendBlocks(blocks);
      const prefix = message ? `${message}。` : "";
      speak(`${prefix}ステップ${step.step_number}。${step.text}`, "periodic", "transition");
    },
    [apiUrl, appendBlocks, speak],
  );

  const handleAnomaly = useCallback(
    (message: string, blocks: Block[]) => {
      appendBlocks([
        { type: "alert", message: message || "何かお困りですか？", severity: "warning" },
        ...blocks,
      ]);
      speak(message || "何かお困りですか？", "periodic", "warn");
    },
    [appendBlocks, speak],
  );

  const handleProactive = useCallback(
    (message: string, blocks: Block[]) => {
      appendBlocks([{ type: "text", content: message, style: "normal" }, ...blocks]);
      speak(message, "periodic", "advise");
    },
    [appendBlocks, speak],
  );

  const { advanceStep, goBackStep, currentStepIndex } = useAutonomousLoop({
    cameraRef,
    sessionId: plan?.session_id ?? "",
    steps: plan?.steps ?? [],
    isActive: isAutonomous && !!plan,
    acquireLock,
    releaseLock,
    onStepAdvanced: handleStepAdvanced,
    onAnomaly: handleAnomaly,
    onProactiveMessage: handleProactive,
  });

  // --- Feedback ---
  const sendFeedback = useFeedback({
    getTargetContent: () => lastInstruction ?? "",
  });

  // --- Voice intent dispatch ---
  const onVoiceIntent = useVoiceIntents({
    capture: () => {
      appendBlocks([{ type: "text", content: "📷 解析中...", style: "emphasis" }]);
      sendChat("教えて");
    },
    advanceStep,
    goBackStep,
    toggleAutonomous: (wantActive) => setIsAutonomous(wantActive),
    getIsAutonomous: () => isAutonomous,
    repeatLast: () => {
      if (!lastInstruction) return;
      const plain = lastInstruction.replace(/[#*_`~>\-]/g, "").replace(/\n+/g, "。");
      speak(plain, "user_action", "respond");
    },
    askChat: (text) => sendChat(text),
    sendFeedback: (sentiment, raw) => sendFeedback(sentiment, "voice", raw),
  });

  const { pauseForTTS, resumeAfterTTS, stopListening } =
    useSpeechRecognition(onVoiceIntent, voiceEnabled);

  useEffect(() => {
    registerTTSCallbacks(pauseForTTS, resumeAfterTTS);
  }, [registerTTSCallbacks, pauseForTTS, resumeAfterTTS]);

  // --- Cleanup ---
  useEffect(() => () => {
    Speech.stop();
    stopListening();
  }, [stopListening]);

  const handleSubmit = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;
    setShowInput(false);
    setInputValue("");
    sendChat(text);
  }, [inputValue, sendChat]);

  const currentStep = plan?.steps[currentStepIndex];
  const currentStepNumber = currentStep?.step_number ?? 0;

  return (
    <View style={styles.root}>
      <GuideLayout
        ref={cameraRef}
        textBlocks={textBlocks}
        timerBlocks={timerBlocks}
        mediaBlocks={mediaBlocks}
        instructionCard={
          lastInstruction ? (
            <InstructionCard
              instruction={lastInstruction}
              currentStep={currentStepNumber}
              totalSteps={plan?.steps.length ?? 0}
              steps={plan?.steps ?? []}
            />
          ) : undefined
        }
        bottomBar={
          <BottomBar
            onBack={() => {
              ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
              setTimeout(() => router.back(), 200);
            }}
            onTextInput={() => setShowInput(true)}
            voiceEnabled={voiceEnabled}
            onToggleVoice={() => setVoiceEnabled((v) => !v)}
            showAutoToggle={!!plan}
            isAutonomous={isAutonomous}
            onToggleAutonomous={() => setIsAutonomous((v) => !v)}
          />
        }
      />

      {showInput ? (
        <ChatInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          onClose={() => setShowInput(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
