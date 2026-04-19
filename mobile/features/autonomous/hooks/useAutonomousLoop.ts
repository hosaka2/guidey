import { useCallback, useEffect, useRef, useState } from "react";

import type { CameraViewHandle } from "@/components/CameraView";
import { useApiContext } from "@/contexts/ApiContext";
import { callPeriodicStream, callPeriodicSync } from "@/lib/api";
import { getStage1Runner, type EdgeMode, type EdgeStep, type Stage1Output } from "@/lib/edge-llm";
import { useCameraCapture } from "@/lib/hooks";
import type { Block, PlanStep, StageEvent } from "@/lib/types";

// --- 定数 (適応的サンプリング) ---
const BASE_INTERVAL_MS = 10000;
const MEDIUM_INTERVAL_MS = 20000;
const LONG_INTERVAL_MS = 30000;
const NO_CHANGE_MEDIUM_THRESHOLD = 5;
const NO_CHANGE_LONG_THRESHOLD = 10;
const STUCK_THRESHOLD = 15;

// --- エッジ同期 ---
const SYNC_INTERVAL_MS = 10000;
const MAX_LOCAL_OBSERVATIONS = 3;

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
};

function toEdgeStep(step: PlanStep | undefined): EdgeStep | null {
  if (!step) return null;
  return {
    step_number: step.step_number,
    text: step.text,
    visual_marker: step.visual_marker ?? "",
  };
}

/**
 * 定期監視ループ。isActive 有効中、適応的間隔で画像を取得 → /periodic SSE → イベント処理。
 *
 * エッジ推論対応:
 *   edgeMode="cloud"            → 従来通り BE で stage1
 *   "gemma-local"/"apple-foundation" → オンデバイスで stage1 (can_handle=true なら BE スキップ、
 *   10 秒毎に /periodic/sync で current_step_index + observations を BE に同期)
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
}: UseAutonomousLoopParams) {
  const { apiUrl, edgeMode } = useApiContext();
  const capture = useCameraCapture(cameraRef);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [captureIntervalMs, setCaptureIntervalMs] = useState(BASE_INTERVAL_MS);

  const isPeriodicRef = useRef(false);
  const noChangeCountRef = useRef(0);
  const stuckCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 進行中の SSE を中断するための controller。
  // 戻るボタン等でループが落ちた後も BE 側の応答 (TTS 用 message 含む) が届き続けるのを防ぐ。
  const abortCtrlRef = useRef<AbortController | null>(null);
  const currentStepIndexRef = useRef(currentStepIndex);
  currentStepIndexRef.current = currentStepIndex;
  const captureIntervalMsRef = useRef(captureIntervalMs);
  captureIntervalMsRef.current = captureIntervalMs;

  const edgeModeRef = useRef<EdgeMode>(edgeMode);
  edgeModeRef.current = edgeMode;

  // エッジ経路専用: on-device で決まった分はここに溜め、/periodic/sync で BE に流す。
  const localObservationsRef = useRef<string[]>([]);
  const pendingSyncObservationsRef = useRef<string[]>([]);
  const pendingSyncStepIndexRef = useRef<number | null>(null);

  const onStepAdvancedRef = useRef(onStepAdvanced);
  onStepAdvancedRef.current = onStepAdvanced;
  const onAnomalyRef = useRef(onAnomaly);
  onAnomalyRef.current = onAnomaly;
  const onProactiveMessageRef = useRef(onProactiveMessage);
  onProactiveMessageRef.current = onProactiveMessage;

  // --- モード切替時にランナーを prepare (バックグラウンド) ---
  useEffect(() => {
    if (edgeMode === "cloud") return;
    const runner = getStage1Runner(edgeMode);
    console.log(`[edge] preparing ${edgeMode}...`);
    runner.prepare().then(
      () => console.log(`[edge] ${edgeMode} ready=${runner.isReady()}`),
      (e) => console.warn(`[edge] ${edgeMode} prepare failed:`, e),
    );
  }, [edgeMode]);

  const pushLocalObservation = useCallback((msg: string) => {
    if (!msg) return;
    const arr = localObservationsRef.current;
    arr.push(msg);
    if (arr.length > MAX_LOCAL_OBSERVATIONS) arr.shift();
    pendingSyncObservationsRef.current.push(msg);
  }, []);

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

  const handleFinalEvent = useCallback(
    (ev: StageEvent) => {
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
    },
    [steps, resetInterval, updateInterval],
  );

  // エッジ判定が can_handle=true で完結する場合: UI 反映だけ行い BE はスキップ。
  const applyEdgeResultLocally = useCallback(
    (stage1: Stage1Output) => {
      const nextIndex =
        stage1.judgment === "next"
          ? Math.min(currentStepIndexRef.current + 1, steps.length - 1)
          : currentStepIndexRef.current;

      const ev: StageEvent = {
        stage: 1,
        escalated: false,
        judgment: stage1.judgment,
        confidence: stage1.confidence,
        message: stage1.message,
        blocks: [],
        current_step_index: nextIndex,
      };

      if (stage1.message) pushLocalObservation(stage1.message);
      if (nextIndex !== currentStepIndexRef.current) {
        pendingSyncStepIndexRef.current = nextIndex;
      }
      handleFinalEvent(ev);
    },
    [steps.length, handleFinalEvent, pushLocalObservation],
  );

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
      const uri = await capture();
      if (!uri) {
        console.warn("[Auto] capture returned null");
        return;
      }

      // エッジ経路: on-device で stage1 を回す
      let stage1Result: Stage1Output | null = null;
      const mode = edgeModeRef.current;
      if (mode !== "cloud") {
        const runner = getStage1Runner(mode);
        if (runner.isReady()) {
          try {
            const step = toEdgeStep(steps[currentStepIndexRef.current]);
            const nextStep = toEdgeStep(steps[currentStepIndexRef.current + 1]);
            if (step) {
              stage1Result = await runner.run({
                currentStep: step,
                nextStep,
                observations: [...localObservationsRef.current],
                imageUri: uri,
              });
            }
          } catch (e) {
            console.warn("[Auto] edge stage1 failed, fallback to cloud:", e);
            stage1Result = null;
          }
        } else {
          console.log(`[edge/${mode}] not ready yet, skipping this tick → cloud`);
        }
      }

      // エッジで完結できるなら BE スキップ (SSE も叩かない)
      if (stage1Result && stage1Result.can_handle) {
        console.log(
          `[edge] local-handled j=${stage1Result.judgment} conf=${stage1Result.confidence.toFixed(2)}`,
        );
        applyEdgeResultLocally(stage1Result);
        return;
      }

      // エッジ結果があればエスカレーションとして BE に持ち込み、なければ cloud stage1
      abortCtrlRef.current = new AbortController();
      await callPeriodicStream(
        apiUrl,
        uri,
        sessionId,
        (ev: StageEvent) => {
          const isFinal = ev.stage === 2 || !ev.escalated;
          if (!isFinal) {
            if (ev.message) onProactiveMessageRef.current(ev.message, ev.blocks ?? []);
            return;
          }
          handleFinalEvent(ev);
          if (ev.message) pushLocalObservation(ev.message);
        },
        stage1Result,
        abortCtrlRef.current.signal,
      );
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        console.log("[Auto] periodic aborted");
      } else {
        console.warn("[AutonomousLoop] error:", err);
      }
    } finally {
      abortCtrlRef.current = null;
      isPeriodicRef.current = false;
      releaseLock();
    }
  }, [
    apiUrl,
    capture,
    sessionId,
    steps,
    acquireLock,
    releaseLock,
    applyEdgeResultLocally,
    handleFinalEvent,
    pushLocalObservation,
  ]);

  // --- タイマー管理 (isActive で on/off) ---
  // runOnce を ref 化: runOnce の再生成で effect が再トリガされないようにする
  // (再トリガ時に await 中の古い runOnce が goast スケジュールして重複発火する事故を防ぐ)
  const runOnceRef = useRef(runOnce);
  runOnceRef.current = runOnce;

  useEffect(() => {
    if (!isActive || steps.length === 0) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // isActive 解除時にも進行中の SSE を中断
      abortCtrlRef.current?.abort();
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await runOnceRef.current();
      if (cancelled) return;
      timerRef.current = setTimeout(tick, captureIntervalMsRef.current);
    };
    timerRef.current = setTimeout(tick, captureIntervalMsRef.current);
    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // unmount / isActive false / steps 変更時に進行中の SSE を中断
      // (戻るボタンで画面離脱後も BE 応答が届いて TTS が鳴り続けるのを防ぐ)
      abortCtrlRef.current?.abort();
    };
  }, [isActive, steps.length]);

  // --- /periodic/sync ループ (エッジ経路専用) ---
  useEffect(() => {
    if (!isActive || edgeMode === "cloud" || !sessionId) return;

    const flush = async () => {
      const obs = pendingSyncObservationsRef.current;
      const idx = pendingSyncStepIndexRef.current;
      if (obs.length === 0 && idx === null) return;

      const payloadObs = [...obs];
      const payloadIdx = idx;
      pendingSyncObservationsRef.current = [];
      pendingSyncStepIndexRef.current = null;

      try {
        const res = await callPeriodicSync(apiUrl, sessionId, payloadIdx, payloadObs);
        console.log(
          `[sync] pushed step=${payloadIdx ?? "-"} obs+=${payloadObs.length} → server step=${res.current_step_index}`,
        );
      } catch (e) {
        console.warn("[sync] failed (will retry on next tick):", e);
        // 戻して次回リトライ
        pendingSyncObservationsRef.current.unshift(...payloadObs);
        if (payloadIdx !== null && pendingSyncStepIndexRef.current === null) {
          pendingSyncStepIndexRef.current = payloadIdx;
        }
      }
    };

    const timer = setInterval(flush, SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isActive, edgeMode, apiUrl, sessionId]);

  // 手動ステップ操作
  const advanceStep = useCallback(() => {
    setCurrentStepIndex((prev) => {
      const next = prev + 1 < steps.length ? prev + 1 : prev;
      if (next !== prev) pendingSyncStepIndexRef.current = next;
      return next;
    });
    resetInterval();
  }, [steps.length, resetInterval]);

  const goBackStep = useCallback(() => {
    setCurrentStepIndex((prev) => {
      const next = prev > 0 ? prev - 1 : prev;
      if (next !== prev) pendingSyncStepIndexRef.current = next;
      return next;
    });
    resetInterval();
  }, [resetInterval]);

  return {
    currentStepIndex,
    captureIntervalMs,
    advanceStep,
    goBackStep,
  };
}
