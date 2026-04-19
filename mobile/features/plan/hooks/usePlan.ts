import { useEffect, useState } from "react";

import { useApiContext } from "@/contexts/ApiContext";
import { fetchPlan } from "@/lib/api";
import type { Plan } from "@/lib/types";

/**
 * plan_source_id + session_id からプランをロード。
 * BE は既存 session に plan_steps を注入してから Plan を返す。
 */
export function usePlan(planSourceId: string | null, sessionId: string | null) {
  const { apiUrl } = useApiContext();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!planSourceId || !sessionId) return;
    let cancelled = false;

    fetchPlan(apiUrl, planSourceId, sessionId)
      .then((p) => {
        if (cancelled) return;
        setPlan(p);
        console.log(
          `[Plan] loaded: ${p.title} (${p.steps.length} steps) session=${p.session_id}`,
        );
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[Plan] fetch failed:", err);
        setError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [apiUrl, planSourceId, sessionId]);

  return { plan, error };
}
