import { useCallback, useEffect, useRef, useState } from "react";

import type { CameraViewHandle } from "@/components/CameraView";
import { useApiContext } from "@/contexts/ApiContext";
import { callPeriodicStream } from "@/lib/api";
import { getStage1Runner, type EdgeMode } from "@/lib/edge-llm";
import type { Block, PlanStep, StageEvent } from "@/lib/types";

// --- 定数 (適応的サンプリング) ---
const BASE_INTERVAL_MS = 3000;
const MEDIUM_INTERVAL_MS = 10000;
const LONG_INTERVAL_MS = 20000;
const NO_CHANGE_MEDIUM_THRESHOLD = 5;
const NO_CHANGE_LONG_THRESHOLD = 10;
const STUCK_THRESHOLD = 15;

type UseAutonomousLoopParams = {
  cameraRef: React.RefObject<CameraViewHandle | null>;
  sessionId: string;
  steps: PlanStep[];
  isActive: boolean;
  acquireLock: () => boolean;
  releaseLock: () => void;
  onStepAdvanced: (step: PlanStep, message: string, blocks: Block[]) => void;
  onAnomaly: (message: string, blocks: Block[]) => void;
  onProactiveMessage: (message: string, blocks: Block[]) => void;
  /** 省略時は "cloud" (BE 側で stage1 実行)。将来的に設定から取得。 */
  edgeMode?: EdgeMode;
};

/**
 * 定期監視ループ。isActive 有効中、適応的間隔で画像を取得 → /periodic SSE → イベント処理。
 *
 * エッジ推論対応:
 *   edgeMode="cloud" なら従来通り BE で stage1。
 *   "gemma-local" / "apple-foundation" ならオンデバイスで stage1 を先に走らせ、
 *   結果を BE に渡して (seed_stage1 経由) stage2 や safety だけサーバで実行。
 */
export function useAutonomousLoop({
  cameraRef,
  sessionId,
  steps,
  isActive,
  acquireLock,
  releaseLock,
  onStepAdvanced,
  onAnomaly,
  onProactiveMessage,
  edgeMode = "cloud",
}: UseAutonomousLoopParams) {
  const { apiUrl } = useApiContext();
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [captureIntervalMs, setCaptureIntervalMs] = useState(BASE_INTERVAL_MS);

  // Refs (再レンダー跨ぎの値)
  const isPeriodicRef = useRef(false);
  const noChangeCountRef = useRef(0);
  const stuckCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentStepIndexRef = useRef(currentStepIndex);
  currentStepIndexRef.current = currentStepIndex;
  const captureIntervalMsRef = useRef(captureIntervalMs);
  captureIntervalMsRef.current = captureIntervalMs;

  // callback は変化するので ref で拾う (最新版を常に呼ぶ)
  const onStepAdvancedRef = useRef(onStepAdvanced);
  onStepAdvancedRef.current = onStepAdvanced;
  const onAnomalyRef = useRef(onAnomaly);
  onAnomalyRef.current = onAnomaly;
  const onProactiveMessageRef = useRef(onProactiveMessage);
  onProactiveMessageRef.current = onProactiveMessage;

  // --- 適応的サンプリング ---
  const updateInterval = useCallback(() => {
    const nc = noChangeCountRef.current;
    setCaptureIntervalMs(
      nc >= NO_CHANGE_LONG_THRESHOLD
        ? LONG_INTERVAL_MS
        : nc >= NO_CHANGE_MEDIUM_THRESHOLD
          ? MEDIUM_INTERVAL_MS
          : BASE_INTERVAL_MS,
    );
  }, []);

  const resetInterval = useCallback(() => {
    noChangeCountRef.current = 0;
    setCaptureIntervalMs(BASE_INTERVAL_MS);
  }, []);

  // --- メインループ (1 tick) ---
  const runOnce = useCallback(async () => {
    if (isPeriodicRef.current) return;
    if (!acquireLock()) {
      console.log("[Auto] skipped: agent busy");
      return;
    }
    if (steps.length === 0) {
      releaseLock();
      return;
    }

    isPeriodicRef.current = true;
    try {
      const uri = await cameraRef.current?.takePicture();
      if (!uri) {
        console.warn("[Auto] takePicture returned null");
        return;
      }

      // エッジモード: stage1 をローカル推論 (未実装時は例外 → cloud フォールバック)
      let stage1Result = null;
      if (edgeMode !== "cloud") {
        try {
          const runner = getStage1Runner(edgeMode);
          stage1Result = await runner.run({ imageBase64: uri, prompt: "" });
        } catch (e) {
          console.warn("[Auto] edge stage1 failed, falling back to cloud:", e);
        }
      }

      await callPeriodicStream(apiUrl, uri, sessionId, (ev: StageEvent) => {
        // stage1 escalated は中間通知 (stage2 を待つ)
        const isFinal = ev.stage === 2 || !ev.escalated;
        if (!isFinal) {
          if (ev.message) {
            onProactiveMessageRef.current(ev.message, ev.blocks ?? []);
          }
          return;
        }

        // 最終判定
        if (ev.judgment === "next") {
          stuckCountRef.current = 0;
          const newIdx = ev.current_step_index ?? currentStepIndexRef.current;
          if (newIdx !== currentStepIndexRef.current && newIdx < steps.length) {
            setCurrentStepIndex(newIdx);
            resetInterval();
            onStepAdvancedRef.current(steps[newIdx], ev.message, ev.blocks ?? []);
          }
        } else if (ev.judgment === "anomaly") {
          stuckCountRef.current = 0;
          resetInterval();
          onAnomalyRef.current(ev.message, ev.blocks ?? []);
        } else {
          // continue
          noChangeCountRef.current += 1;
          stuckCountRef.current += 1;
          updateInterval();

          if (ev.message) {
            onProactiveMessageRef.current(ev.message, ev.blocks ?? []);
            stuckCountRef.current = 0;
          }
          if (stuckCountRef.current >= STUCK_THRESHOLD) {
            stuckCountRef.current = 0;
            onProactiveMessageRef.current(
              "しばらく同じ状態が続いています。大丈夫ですか？何かお手伝いできることがあれば声をかけてください。",
              [{ type: "alert", message: "作業が止まっているようです", severity: "info" }],
            );
          }
        }
      }, stage1Result);
    } catch (err) {
      console.warn("[AutonomousLoop] error:", err);
    } finally {
      isPeriodicRef.current = false;
      releaseLock();
    }
  }, [
    apiUrl, cameraRef, sessionId, steps, edgeMode,
    acquireLock, releaseLock, resetInterval, updateInterval,
  ]);

  // --- タイマー管理 (isActive で on/off) ---
  useEffect(() => {
    if (!isActive || steps.length === 0) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const scheduleNext = () => {
      timerRef.current = setTimeout(async () => {
        await runOnce();
        if (isActive) scheduleNext();
      }, captureIntervalMsRef.current);
    };
    scheduleNext();
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isActive, steps.length, runOnce]);

  // 手動ステップ操作
  const advanceStep = useCallback(() => {
    setCurrentStepIndex((prev) =>
      prev + 1 < steps.length ? prev + 1 : prev,
    );
    resetInterval();
  }, [steps.length, resetInterval]);

  const goBackStep = useCallback(() => {
    setCurrentStepIndex((prev) => (prev > 0 ? prev - 1 : prev));
    resetInterval();
  }, [resetInterval]);

  return {
    currentStepIndex,
    captureIntervalMs,
    advanceStep,
    goBackStep,
  };
}
