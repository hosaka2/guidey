import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Speech from "expo-speech";

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
import { useAgentState, useBlockRouter, useOrientationLock } from "@/lib/hooks";
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
  useOrientationLock();
  const { planId, sessionId } = useLocalSearchParams<{ planId: string; sessionId: string }>();
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

  // --- プラン取得 (session_id は goal.tsx で採番済み) ---
  // 画面の orientation は app/_layout.tsx の Stack.Screen options で宣言 (landscape)
  const { plan } = usePlan(planId ?? null, sessionId ?? null);

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

  // 直前の proactive と内容が酷似していたら反復とみなしてスキップ。
  // 時間ベースのクールダウンは入れない (本当に必要な声かけも止めてしまうため)。
  const lastProactiveRef = useRef<string>("");
  const handleProactive = useCallback(
    (message: string, blocks: Block[]) => {
      const text = (message ?? "").trim();
      if (!text) return;
      if (similarity(lastProactiveRef.current, text) > 0.5) {
        console.log("[proactive] skipped duplicate:", text.slice(0, 40));
        return;
      }
      lastProactiveRef.current = text;
      appendBlocks([{ type: "text", content: text, style: "normal" }, ...blocks]);
      speak(text, "periodic", "advise");
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
            onBack={() => router.back()}
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

/** 2-gram Jaccard 類似度。「ほぼ同じ案内を繰り返している」の検出用 (軽量、文字ベース)。 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
