import { useCallback, useEffect, useRef, useState } from "react";

import type { CameraViewHandle } from "@/components/CameraView";
import type { Block } from "@/types/blocks";
import type { Plan, PlanStep } from "@/types/plan";
import { callJudge, fetchPlan } from "./useJudgeApi";

// --- 定数 ---
const BASE_INTERVAL_MS = 5000;
const MEDIUM_INTERVAL_MS = 15000;
const LONG_INTERVAL_MS = 30000;
const NO_CHANGE_MEDIUM_THRESHOLD = 3;
const NO_CHANGE_LONG_THRESHOLD = 6;
const HYSTERESIS_THRESHOLD = 2;
const MAX_OBSERVATIONS = 3;

type UseAutonomousLoopParams = {
  cameraRef: React.RefObject<CameraViewHandle | null>;
  apiUrl: string;
  planSourceId: string;
  onStepAdvanced: (step: PlanStep, message: string, blocks: Block[]) => void;
  onAnomaly: (message: string, blocks: Block[]) => void;
};

export function useAutonomousLoop({
  cameraRef,
  apiUrl,
  planSourceId,
  onStepAdvanced,
  onAnomaly,
}: UseAutonomousLoopParams) {
  const [isActive, setIsActive] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [captureIntervalMs, setCaptureIntervalMs] = useState(BASE_INTERVAL_MS);

  // Refs for loop state (avoid stale closures)
  const isJudgingRef = useRef(false);
  const noChangeCountRef = useRef(0);
  const consecutiveNextCountRef = useRef(0);
  const recentObservationsRef = useRef<string[]>([]);
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

  // --- メインループ (変化検知はバックエンドAppraiseノードで実施) ---
  const runOnce = useCallback(async () => {
    if (isJudgingRef.current) return;
    const p = planRef.current;
    if (!p) return;

    isJudgingRef.current = true;
    try {
      // 1. カメラキャプチャ
      const uri = await cameraRef.current?.takePicture();
      if (!uri) return;

      // 2. 変化検知はバックエンド側 (Appraise ノード) で実施
      //    手持ちカメラのブレはファイルサイズでは判定不能

      // 3. Judge API 呼び出し
      const result = await callJudge(
        apiUrl,
        uri,
        p.source_id,
        currentStepIndexRef.current,
        recentObservationsRef.current
      );

      // 4. observations 更新
      if (result.message) {
        const obs = recentObservationsRef.current;
        obs.push(result.message);
        if (obs.length > MAX_OBSERVATIONS) obs.shift();
      }

      // 5. 判定処理
      console.log(`[Auto] judgment=${result.judgment} consecutiveNext=${consecutiveNextCountRef.current} stepIdx=${currentStepIndexRef.current}`);
      if (result.judgment === "next") {
        consecutiveNextCountRef.current++;
        if (consecutiveNextCountRef.current >= HYSTERESIS_THRESHOLD) {
          // ステップ進行
          const nextIdx = currentStepIndexRef.current + 1;
          console.log(`[Auto] ★ STEP ADVANCED → ${nextIdx}/${p.steps.length}`);
          if (nextIdx < p.steps.length) {
            setCurrentStepIndex(nextIdx);
            consecutiveNextCountRef.current = 0;
            resetInterval();
            onStepAdvancedRef.current(p.steps[nextIdx], result.message, result.blocks || []);
          } else {
            console.log(`[Auto] Already at last step, no advance`);
          }
        }
      } else if (result.judgment === "anomaly") {
        consecutiveNextCountRef.current = 0;
        resetInterval();
        onAnomalyRef.current(result.message, result.blocks || []);
      } else {
        // continue
        consecutiveNextCountRef.current = 0;
        noChangeCountRef.current++;
        updateInterval();
      }
    } catch (err) {
      console.warn("[AutonomousLoop] error:", err);
    } finally {
      isJudgingRef.current = false;
    }
  }, [apiUrl, cameraRef, resetInterval, updateInterval]);

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
    // isActive と plan の変更でタイマーを再設定
    // captureIntervalMs は ref 経由で読むので依存に含めない
  }, [isActive, plan, runOnce]);

  // --- 初回マウント時にプラン取得 ---
  useEffect(() => {
    if (!planSourceId || plan) return;
    fetchPlan(apiUrl, planSourceId)
      .then((fetched) => {
        console.log(`[Auto] Plan loaded: ${fetched.title} (${fetched.steps.length} steps)`);
        setPlan(fetched);
      })
      .catch((err) => {
        console.warn("[AutonomousLoop] Failed to fetch plan:", err);
      });
  }, [planSourceId, apiUrl, plan]);

  // --- トグル ---
  const toggleAutonomous = useCallback(async () => {
    if (isActive) {
      // 停止
      setIsActive(false);
      return;
    }

    if (!plan) {
      console.warn("[AutonomousLoop] No plan available");
      return;
    }

    // 状態リセット
    setCurrentStepIndex(0);
    setCaptureIntervalMs(BASE_INTERVAL_MS);
    noChangeCountRef.current = 0;
    consecutiveNextCountRef.current = 0;
    recentObservationsRef.current = [];
    isJudgingRef.current = false;

    setIsActive(true);
  }, [isActive, plan]);

  // --- 手動でステップを進める/戻す ---
  const advanceStep = useCallback(() => {
    const p = planRef.current;
    if (!p) return;
    const nextIdx = currentStepIndexRef.current + 1;
    if (nextIdx < p.steps.length) {
      setCurrentStepIndex(nextIdx);
      resetInterval();
      consecutiveNextCountRef.current = 0;
    }
  }, [resetInterval]);

  const goBackStep = useCallback(() => {
    const prevIdx = currentStepIndexRef.current - 1;
    if (prevIdx >= 0) {
      setCurrentStepIndex(prevIdx);
      resetInterval();
      consecutiveNextCountRef.current = 0;
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
