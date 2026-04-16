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
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Speech from "expo-speech";

import { CameraView, CameraViewHandle } from "@/components/CameraView";
import { useAgentState, type SpeakType } from "@/hooks/useAgentState";
import { callChat, startSession } from "@/hooks/useJudgeApi";
import {
  useSpeechRecognition,
  type VoiceIntent,
} from "@/hooks/useSpeechRecognition";
import { useApiContext } from "@/contexts/ApiContext";
import type { Block } from "@/types/blocks";
import { BlockRenderer } from "@/components/BlockRenderer";

const ACCENT = "#6C63FF";

export default function ExploreScreen() {
  const router = useRouter();
  const cameraRef = useRef<CameraViewHandle>(null);
  const { apiUrl } = useApiContext();

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activeBlocks, setActiveBlocks] = useState<Block[]>([]);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInputValue, setTextInputValue] = useState("");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  const blocksMaxH = Dimensions.get("window").height * 0.5;

  // --- refs ---
  const sendChatRef = useRef<(msg: string) => void>(() => {});
  const agentSpeakRef = useRef<(msg: string, src: "periodic" | "user_action", speakType?: SpeakType) => boolean>(() => false);

  // --- Voice ---
  const handleVoiceTrigger = useCallback(
    (action: VoiceIntent, raw?: string) => {
      switch (action) {
        case "stop":
          Speech.stop();
          break;
        case "question":
        case "report_status":
        case "request_help":
          if (raw) sendChatRef.current(raw);
          break;
        default:
          if (raw && raw.length >= 4) sendChatRef.current(raw);
          break;
      }
    },
    []
  );

  const { isListening, pauseForTTS, resumeAfterTTS } =
    useSpeechRecognition(handleVoiceTrigger, voiceEnabled);

  // --- SharedState ---
  const {
    speak: agentSpeak,
    registerTTSCallbacks,
  } = useAgentState();

  agentSpeakRef.current = agentSpeak;

  useEffect(() => {
    registerTTSCallbacks(pauseForTTS, resumeAfterTTS);
  }, [registerTTSCallbacks, pauseForTTS, resumeAfterTTS]);

  // --- セッション開始 ---
  useEffect(() => {
    if (sessionId) return;
    startSession(apiUrl)
      .then((res) => {
        console.log(`[Explore] session started: ${res.session_id}`);
        setSessionId(res.session_id);
      })
      .catch((err) => {
        console.warn("[Explore] session start failed:", err);
      });
  }, [apiUrl, sessionId]);

  // --- ブロック表示 ---
  const showBlocks = useCallback((blocks: Block[]) => {
    if (blocks.length > 0) {
      setActiveBlocks((prev) => [...prev, ...blocks].slice(-20));
    }
  }, []);

  // --- チャット送信 ---
  const sendChat = useCallback(
    async (userMsg: string) => {
      if (!sessionId || isLoading) return;
      setIsLoading(true);

      showBlocks([{ type: "text", content: `💬 ${userMsg}`, style: "emphasis" } as Block]);

      const uri = await cameraRef.current?.takePicture();
      try {
        const result = await callChat(apiUrl, userMsg, uri ?? null, sessionId);

        const blocks: Block[] = result.blocks || [];
        if (result.message) {
          blocks.unshift({ type: "text", content: result.message, style: "normal" });
        }
        showBlocks(blocks);

        if (result.message) {
          agentSpeakRef.current(result.message, "user_action", "respond");
        }
      } catch (err) {
        console.warn("[Explore] chat error:", err);
        showBlocks([{ type: "alert", message: "エラーが発生しました", severity: "warning" } as Block]);
      } finally {
        setIsLoading(false);
      }
    },
    [apiUrl, sessionId, isLoading, showBlocks]
  );

  sendChatRef.current = sendChat;

  const handleTextSubmit = useCallback(() => {
    const text = textInputValue.trim();
    if (!text) return;
    setShowTextInput(false);
    setTextInputValue("");
    sendChat(text);
  }, [textInputValue, sendChat]);

  // --- Cleanup ---
  useEffect(() => {
    return () => {
      Speech.stop();
    };
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={StyleSheet.absoluteFill}>
        <CameraView ref={cameraRef} />
      </View>

      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Feather name="chevron-left" size={28} color="#fff" />
        </Pressable>
        <Text fontSize="$5" fontWeight="700" color="#fff">
          探索モード
        </Text>
        <View width={28} />
      </View>

      {/* Blocks (chat area) */}
      {activeBlocks.length > 0 && (
        <View style={[styles.blocksArea, { maxHeight: blocksMaxH }]}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <BlockRenderer blocks={activeBlocks} />
          </ScrollView>
        </View>
      )}

      {/* Bottom bar */}
      <View style={styles.bottomBar}>
        <Pressable
          style={[styles.micBtn, voiceEnabled && styles.micBtnActive]}
          onPress={() => setVoiceEnabled((v) => !v)}
        >
          <Feather
            name={voiceEnabled ? "mic" : "mic-off"}
            size={24}
            color={voiceEnabled ? "#fff" : "#999"}
          />
        </Pressable>

        <Pressable
          style={styles.textBtn}
          onPress={() => setShowTextInput(true)}
        >
          <Feather name="edit-2" size={22} color="#fff" />
          <Text color="#fff" fontSize="$2" opacity={0.8}>質問する</Text>
        </Pressable>
      </View>

      {/* Text input modal */}
      <Modal visible={showTextInput} transparent animationType="slide">
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <View style={styles.modalContent}>
            <TextInput
              style={styles.textInput}
              placeholder="質問を入力..."
              placeholderTextColor="#999"
              value={textInputValue}
              onChangeText={setTextInputValue}
              autoFocus
              onSubmitEditing={handleTextSubmit}
              returnKeyType="send"
            />
            <Pressable onPress={handleTextSubmit} style={styles.sendBtn}>
              <Feather name="send" size={20} color="#fff" />
            </Pressable>
            <Pressable onPress={() => setShowTextInput(false)} style={styles.closeBtn}>
              <Feather name="x" size={20} color="#666" />
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#000" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  blocksArea: {
    position: "absolute",
    bottom: 100,
    left: 8,
    right: 8,
    backgroundColor: "rgba(0,0,0,0.3)",
    borderRadius: 12,
    padding: 8,
  },
  bottomBar: {
    position: "absolute",
    bottom: 30,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 20,
  },
  micBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  micBtnActive: {
    backgroundColor: "#4ADE80",
  },
  textBtn: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 28,
    backgroundColor: ACCENT,
    alignItems: "center",
    justifyContent: "center",
  },
  modalOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  modalContent: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    padding: 12,
    gap: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: "#F5F5F5",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#6C63FF",
    alignItems: "center",
    justifyContent: "center",
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#E5E5E5",
    alignItems: "center",
    justifyContent: "center",
  },
});
