import { useState, useCallback, useRef } from "react";
import { GuideModeType } from "@/constants/Config";
import { useApiContext } from "@/contexts/ApiContext";

export type StepSummary = {
  step_number: number;
  text: string;
  frame_url: string;
};

type StreamMeta = {
  reference_image_url?: string;
  current_step?: number;
  total_steps?: number;
  steps?: StepSummary[];
};

function buildFormData(
  imageUri: string,
  mode: GuideModeType,
  triggerWord: string,
  goal: string
): FormData {
  const formData = new FormData();
  formData.append("file", {
    uri: imageUri,
    name: "photo.jpg",
    type: "image/jpeg",
  } as unknown as Blob);
  formData.append("mode", mode);
  formData.append("trigger_word", triggerWord);
  formData.append("goal", goal);
  return formData;
}

/** 文の区切り文字 */
const SENTENCE_DELIMITERS = /([。！？\n])/;

function streamSSE(
  url: string,
  formData: FormData,
  onChunk: (fullText: string) => void,
  onSentence: (sentence: string) => void,
  onMeta: (meta: StreamMeta) => void,
  onDone: (fullText: string) => void,
  onError: (err: string) => void
): () => void {
  const xhr = new XMLHttpRequest();
  let fullText = "";
  let lastIndex = 0;
  let pendingSentence = "";

  const t0 = Date.now();
  let firstChunkLogged = false;

  xhr.open("POST", url);
  xhr.setRequestHeader("Accept", "text/event-stream");

  xhr.onreadystatechange = () => {
    if (xhr.readyState >= 3 && xhr.status === 200) {
      if (!firstChunkLogged) {
        console.log(`[SSE] first data at ${Date.now() - t0}ms`);
        firstChunkLogged = true;
      }
      const newData = xhr.responseText.substring(lastIndex);
      lastIndex = xhr.responseText.length;

      const lines = newData.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        // メタイベントをチェック (JSONで {"type":"meta",...} の形式)
        if (data.startsWith("{")) {
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === "meta") {
              onMeta(parsed);
              continue;
            }
          } catch {
            // JSONパース失敗 → 通常のテキストチャンクとして扱う
          }
        }

        // テキストチャンクはJSON文字列でエンコードされている
        let text: string;
        try {
          text = JSON.parse(data);
        } catch {
          text = data;
        }
        fullText += text;
        onChunk(fullText);

        // 文の区切りを検知して即読み上げ
        pendingSentence += text;
        const parts = pendingSentence.split(SENTENCE_DELIMITERS);
        while (parts.length >= 2) {
          const text = parts.shift()!;
          const delim = parts.shift()!;
          const sentence = (text + delim).trim();
          if (sentence) onSentence(sentence);
        }
        pendingSentence = parts.join("");
      }
    }

    if (xhr.readyState === 4) {
      console.log(`[SSE] complete at ${Date.now() - t0}ms, status=${xhr.status}, textLen=${fullText.length}`);
      if (xhr.status === 200) {
        if (pendingSentence.trim()) {
          onSentence(pendingSentence.trim());
        }
        onDone(fullText);
      } else if (xhr.status > 0) {
        onError(`API error: ${xhr.status}`);
      }
    }
  };

  xhr.onerror = () => onError("ネットワークエラー");
  xhr.send(formData);

  return () => xhr.abort();
}

export function useGuideApi() {
  const { apiUrl } = useApiContext();
  const [isLoading, setIsLoading] = useState(false);
  const [lastInstruction, setLastInstruction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [referenceImageUrl, setReferenceImageUrl] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<number | null>(null);
  const [totalSteps, setTotalSteps] = useState<number | null>(null);
  const [steps, setSteps] = useState<StepSummary[]>([]);
  const abortRef = useRef<(() => void) | null>(null);

  const analyzeStream = useCallback(
    (
      imageUri: string,
      mode: GuideModeType,
      triggerWord: string,
      goal: string = "",
      onSentence?: (sentence: string) => void
    ): Promise<string | null> => {
      abortRef.current?.();

      setIsLoading(true);
      setError(null);
      // 指示カードの内容はリセットしない (ステップ遷移時のみ更新)

      const formData = buildFormData(imageUri, mode, triggerWord, goal);

      return new Promise((resolve) => {
        const abort = streamSSE(
          `${apiUrl}/guide/analyze/stream`,
          formData,
          (_fullText) => {}, // ブロックカードで表示するため指示カードは更新しない
          (sentence) => onSentence?.(sentence),
          (meta) => {
            if (meta.reference_image_url) {
              setReferenceImageUrl(`${apiUrl}${meta.reference_image_url}`);
            }
            if (meta.current_step) setCurrentStep(meta.current_step);
            if (meta.total_steps) setTotalSteps(meta.total_steps);
            if (meta.steps) setSteps(meta.steps);
          },
          (fullText) => {
            setIsLoading(false);
            abortRef.current = null;
            resolve(fullText || null);
          },
          (errMsg) => {
            setError(errMsg);
            setIsLoading(false);
            abortRef.current = null;
            resolve(null);
          }
        );
        abortRef.current = abort;
      });
    },
    [apiUrl]
  );

  const testConnection = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(`${apiUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, [apiUrl]);

  return {
    analyzeStream,
    testConnection,
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
  };
}
