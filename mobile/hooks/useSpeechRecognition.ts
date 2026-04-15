import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

// --- Intent 定義 ---

export type VoiceIntent =
  | "capture"            // 撮影→解析 (手動モード)
  | "next_step"          // 次のステップへ
  | "previous_step"      // 前のステップへ
  | "skip"               // スキップ
  | "stop"               // TTS停止
  | "pause"              // 自律モード一時停止
  | "resume"             // 自律モード再開
  | "repeat"             // もう一度読み上げ
  | "question"           // 質問 (「これでいい？」)
  | "report_status"      // 状況報告 (「切ったよ」)
  | "request_help"       // 助けて
  | "feedback_positive"  // 明示的ポジティブ
  | "feedback_negative"  // 明示的ネガティブ
  | "unknown";           // 不明 (transcript付きで通知)

type IntentMapping = {
  words: string[];
  intent: VoiceIntent;
};

/** キーワードマッチ (高速、LLM不要) */
const INTENT_MAP: IntentMapping[] = [
  // 基本操作 (α)
  { words: ["教えて", "おしえて"], intent: "capture" },
  { words: ["次", "つぎ", "進めて", "できた", "オッケー", "おっけー"], intent: "next_step" },
  { words: ["戻して", "戻る", "もどして", "前"], intent: "previous_step" },
  { words: ["スキップ", "飛ばして", "とばして"], intent: "skip" },
  { words: ["ストップ", "止めて", "やめて", "とめて"], intent: "stop" },
  { words: ["待って", "まって", "ちょっと", "一時停止"], intent: "pause" },
  { words: ["再開", "さいかい", "続き", "つづき", "続けて"], intent: "resume" },
  { words: ["もう一回", "もういっかい", "もう一度", "リピート"], intent: "repeat" },
  // 対話系 (β)
  { words: ["これでいい", "いい感じ", "合ってる", "大丈夫"], intent: "question" },
  { words: ["切った", "終わった", "やった", "入れた", "混ぜた"], intent: "report_status" },
  { words: ["分からない", "わからない", "助けて", "たすけて", "ヘルプ"], intent: "request_help" },
  // フィードバック
  { words: ["いいね", "助かった", "ありがとう", "そうそう", "正解"], intent: "feedback_positive" },
  { words: ["違う", "間違ってる", "そうじゃない", "ちがう", "やり直し"], intent: "feedback_negative" },
];

const COOLDOWN_MS = 2500;
const RESTART_DELAY_MS = 300;

function detectIntent(transcript: string): { intent: VoiceIntent; raw: string } | null {
  for (const { words, intent } of INTENT_MAP) {
    if (words.some((w) => transcript.includes(w))) {
      return { intent, raw: transcript };
    }
  }
  // 一定の長さの発話はunknownとして通知 (LLM分類用)
  if (transcript.length >= 4) {
    return { intent: "unknown", raw: transcript };
  }
  return null;
}

// --- 後方互換: 旧TriggerAction型 ---
export type TriggerAction = VoiceIntent;

export function useSpeechRecognition(
  onTrigger: (action: VoiceIntent, raw?: string) => void,
  enabled: boolean = true
) {
  const [isListening, setIsListening] = useState(false);

  const shouldBeListening = useRef(false);
  const pausedForTTS = useRef(false);
  const lastTriggerTime = useRef(0);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startRecognition = useCallback(() => {
    ExpoSpeechRecognitionModule.start({
      lang: "ja-JP",
      continuous: true,
      interimResults: true,
      contextualStrings: [
        "教えて", "次", "ストップ", "止めて", "待って", "再開",
        "もう一回", "戻して", "スキップ", "これでいい", "助けて",
      ],
    });
  }, []);

  const startListening = useCallback(async () => {
    const { granted } =
      await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!granted) return;
    shouldBeListening.current = true;
    pausedForTTS.current = false;
    startRecognition();
  }, [startRecognition]);

  const stopListening = useCallback(() => {
    shouldBeListening.current = false;
    if (restartTimer.current) {
      clearTimeout(restartTimer.current);
      restartTimer.current = null;
    }
    ExpoSpeechRecognitionModule.abort();
  }, []);

  const pauseForTTS = useCallback(() => {
    pausedForTTS.current = true;
    ExpoSpeechRecognitionModule.abort();
  }, []);

  const resumeAfterTTS = useCallback(() => {
    pausedForTTS.current = false;
    if (shouldBeListening.current) {
      restartTimer.current = setTimeout(() => {
        startRecognition();
      }, RESTART_DELAY_MS);
    }
  }, [startRecognition]);

  // --- イベントハンドラ ---

  useSpeechRecognitionEvent("start", () => {
    setIsListening(true);
  });

  useSpeechRecognitionEvent("end", () => {
    setIsListening(false);
    if (shouldBeListening.current && !pausedForTTS.current) {
      restartTimer.current = setTimeout(() => {
        startRecognition();
      }, RESTART_DELAY_MS);
    }
  });

  useSpeechRecognitionEvent("result", (event) => {
    const transcript = event.results[0]?.transcript ?? "";
    const detected = detectIntent(transcript);

    if (detected) {
      const now = Date.now();
      if (now - lastTriggerTime.current < COOLDOWN_MS) return;
      lastTriggerTime.current = now;
      onTrigger(detected.intent, detected.raw);
    }
  });

  useSpeechRecognitionEvent("error", (event) => {
    const isNormal = event.error === "no-speech" || event.error === "aborted";
    if (!isNormal) {
      console.warn("[SpeechRecognition] error:", event.error, event.message);
    }
    setIsListening(false);

    if (shouldBeListening.current && !pausedForTTS.current) {
      restartTimer.current = setTimeout(() => {
        startRecognition();
      }, isNormal ? RESTART_DELAY_MS : 2000);
    }
  });

  // --- ライフサイクル ---

  useEffect(() => {
    if (enabled) {
      startListening();
    } else {
      stopListening();
    }
    return () => {
      stopListening();
    };
  }, [enabled, startListening, stopListening]);

  return {
    isListening,
    startListening,
    stopListening,
    pauseForTTS,
    resumeAfterTTS,
  };
}
