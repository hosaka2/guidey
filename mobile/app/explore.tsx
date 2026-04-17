import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import * as Speech from "expo-speech";
import * as ScreenOrientation from "expo-screen-orientation";

import { BottomBar } from "@/components/BottomBar";
import { CameraViewHandle } from "@/components/CameraView";
import { GuideLayout } from "@/components/layout";
import { View } from "@/components/ui";
import { useApiContext } from "@/contexts/ApiContext";
import { ChatInput, useChat } from "@/features/chat";
import { useSpeechRecognition, useVoiceIntents } from "@/features/voice";
import { startSession } from "@/lib/api";
import { useAgentState, useBlockRouter } from "@/lib/hooks";
import type { Block } from "@/lib/types";

/**
 * 探索モード画面 (プランなし)。カメラ + 音声入力 + チャット応答のみ。
 * 役割の薄い orchestrator: session 取得 → features を composition。
 */
export default function ExploreScreen() {
  const router = useRouter();
  const cameraRef = useRef<CameraViewHandle>(null);
  const { apiUrl } = useApiContext();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activeBlocks, setActiveBlocks] = useState<Block[]>([]);
  const [showInput, setShowInput] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [voiceEnabled, setVoiceEnabled] = useState(true);

  // --- 横向きロック (画面離脱時に戻す) ---
  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
    return () => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, []);

  // --- セッション (BE で seed) ---
  useEffect(() => {
    if (sessionId) return;
    startSession(apiUrl)
      .then((r) => setSessionId(r.session_id))
      .catch((e) => console.warn("[Explore] session start failed:", e));
  }, [apiUrl, sessionId]);

  // --- ブロック表示: 追記型、最新 20 件を保持 ---
  const { textBlocks, timerBlocks, mediaBlocks } = useBlockRouter(activeBlocks);
  const appendBlocks = useCallback((blocks: Block[]) => {
    if (blocks.length === 0) return;
    setActiveBlocks((prev) => [...prev, ...blocks].slice(-20));
  }, []);

  // --- 音声 + TTS 連携 ---
  const { speak, registerTTSCallbacks } = useAgentState();
  const { sendChat } = useChat({
    cameraRef,
    sessionId: sessionId ?? "",
    onBlocks: appendBlocks,
    onSpeak: (msg, type) => speak(msg, "user_action", type),
  });

  const onVoiceIntent = useVoiceIntents({
    askChat: (text) => {
      if (sessionId) sendChat(text);
    },
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

  return (
    <View style={styles.root}>
      <GuideLayout
        ref={cameraRef}
        textBlocks={textBlocks}
        timerBlocks={timerBlocks}
        mediaBlocks={mediaBlocks}
        bottomBar={
          <BottomBar
            onBack={() => {
              ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
              setTimeout(() => router.back(), 200);
            }}
            onTextInput={() => setShowInput(true)}
            voiceEnabled={voiceEnabled}
            onToggleVoice={() => setVoiceEnabled((v) => !v)}
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
