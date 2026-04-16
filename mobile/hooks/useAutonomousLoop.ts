import { useCallback, useEffect, useRef, useState } from "react";

import type { CameraViewHandle } from "@/components/CameraView";
import type { Block } from "@/types/blocks";
import type { Plan, PlanStep } from "@/types/plan";
import { callJudge, fetchPlan } from "./useJudgeApi";

// --- 定数 ---
const BASE_INTERVAL_MS = 3000;
const MEDIUM_INTERVAL_MS = 10000;
const LONG_INTERVAL_MS = 20000;
const NO_CHANGE_MEDIUM_THRESHOLD = 5;
const NO_CHANGE_LONG_THRESHOLD = 10;
const MAX_OBSERVATIONS = 3;
const STUCK_THRESHOLD = 15;

type UseAutonomousLoopParams = {
  cameraRef: React.RefObject<CameraViewHandle | null>;
  apiUrl: string;
  planSourceId: string;
  acquireLock: () => boolean;
  releaseLock: () => void;
  onStepAdvanced: (step: PlanStep, message: string, blocks: Block[]) => void;
  onAnomaly: (message: string, blocks: Block[]) => void;
  onProactiveMessage: (message: string, blocks: Block[]) => void;
};

export function useAutonomousLoop({
  cameraRef,
  apiUrl,
  planSourceId,
  acquireLock,
  releaseLock,
  onStepAdvanced,
  onAnomaly,
  onProactiveMessage,
}: UseAutonomousLoopParams) {
  const [isActive, setIsActive] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [captureIntervalMs, setCaptureIntervalMs] = useState(BASE_INTERVAL_MS);

  // Refs
  const isJudgingRef = useRef(false);
  const noChangeCountRef = useRef(0);
  const stuckCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable refs for callbacks
  const currentStepIndexRef = useRef(currentStepIndex);
  currentStepIndexRef.current = currentStepIndex;
  const captureIntervalMsRef = useRef(captureIntervalMs);
  captureIntervalMsRef.current = captureIntervalMs;
  const planRef = useRef(plan);
  planRef.current = plan;
  const onStepAdvancedRef = useRef(onStepAdvanced);
  onStepAdvancedRef.current = onStepAdvanced;
  const onAnomalyRef = useRef(onAnomaly);
  onAnomalyRef.current = onAnomaly;
  const onProactiveMessageRef = useRef(onProactiveMessage);
  onProactiveMessageRef.current = onProactiveMessage;

  // --- 適応的サンプリング ---
  const updateInterval = useCallback(() => {
    const nc = noChangeCountRef.current;
    let interval = BASE_INTERVAL_MS;
    if (nc >= NO_CHANGE_LONG_THRESHOLD) {
      interval = LONG_INTERVAL_MS;
    } else if (nc >= NO_CHANGE_MEDIUM_THRESHOLD) {
      interval = MEDIUM_INTERVAL_MS;
    }
    setCaptureIntervalMs(interval);
  }, []);

  const resetInterval = useCallback(() => {
    noChangeCountRef.current = 0;
    setCaptureIntervalMs(BASE_INTERVAL_MS);
  }, []);

  // --- メインループ ---
  const runOnce = useCallback(async () => {
    if (isJudgingRef.current) return;

    if (!acquireLock()) {
      console.log("[Auto] skipped: agent busy");
      return;
    }

    const p = planRef.current;
    if (!p) {
      releaseLock();
      return;
    }

    isJudgingRef.current = true;
    try {
      const uri = await cameraRef.current?.takePicture();
      if (!uri) {
        console.warn("[Auto] takePicture returned null");
        return;
      }

      // session_id + image のみ送信。コンテキストは BE が管理。
      const result = await callJudge(apiUrl, uri, p.session_id);

      // 判定処理
      console.log(`[Auto] judgment=${result.judgment} stepIdx=${result.current_step_index}`);

      if (result.judgment === "next") {
        stuckCountRef.current = 0;
        // BE がステップ進行済み。response の current_step_index で同期。
        const newIdx = result.current_step_index;
        if (newIdx !== currentStepIndexRef.current && newIdx < p.steps.length) {
          setCurrentStepIndex(newIdx);
          resetInterval();
          onStepAdvancedRef.current(p.steps[newIdx], result.message, result.blocks || []);
        }
      } else if (result.judgment === "anomaly") {
        stuckCountRef.current = 0;
        resetInterval();
        onAnomalyRef.current(result.message, result.blocks || []);
      } else {
        // continue
        noChangeCountRef.current++;
        stuckCountRef.current++;
        updateInterval();

        if (result.message) {
          onProactiveMessageRef.current(result.message, result.blocks || []);
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
    } catch (err) {
      console.warn("[AutonomousLoop] error:", err);
    } finally {
      isJudgingRef.current = false;
      releaseLock();
    }
  }, [apiUrl, cameraRef, resetInterval, updateInterval, acquireLock, releaseLock]);

  // --- タイマー管理 ---
  useEffect(() => {
    if (!isActive || !plan) {
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
  }, [isActive, plan, runOnce]);

  // --- 初回マウント時にプラン取得 → 自動開始 ---
  useEffect(() => {
    if (!planSourceId || plan) return;
    fetchPlan(apiUrl, planSourceId)
      .then((fetched) => {
        console.log(`[Auto] Plan loaded: ${fetched.title} (${fetched.steps.length} steps) session=${fetched.session_id}`);
        setPlan(fetched);
        setCurrentStepIndex(0);
        setCaptureIntervalMs(BASE_INTERVAL_MS);
        noChangeCountRef.current = 0;
        stuckCountRef.current = 0;
        setIsActive(true);
        console.log("[Auto] ★ Auto-started");
      })
      .catch((err) => {
        console.warn("[AutonomousLoop] Failed to fetch plan:", err);
      });
  }, [planSourceId, apiUrl, plan]);

  // --- トグル ---
  const toggleAutonomous = useCallback(async () => {
    if (isActive) {
      setIsActive(false);
      return;
    }
    if (!plan) {
      console.warn("[AutonomousLoop] No plan available");
      return;
    }
    setIsActive(true);
  }, [isActive, plan]);

  // --- 手動ステップ操作 ---
  const advanceStep = useCallback(() => {
    const p = planRef.current;
    if (!p) return;
    const nextIdx = currentStepIndexRef.current + 1;
    if (nextIdx < p.steps.length) {
      setCurrentStepIndex(nextIdx);
      resetInterval();
    }
  }, [resetInterval]);

  const goBackStep = useCallback(() => {
    const prevIdx = currentStepIndexRef.current - 1;
    if (prevIdx >= 0) {
      setCurrentStepIndex(prevIdx);
      resetInterval();
    }
  }, [resetInterval]);

  return {
    isActive,
    plan,
    currentStepIndex,
    captureIntervalMs,
    toggleAutonomous,
    advanceStep,
    goBackStep,
  };
}
