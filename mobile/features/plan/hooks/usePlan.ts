import { useEffect, useState } from "react";

import { useApiContext } from "@/contexts/ApiContext";
import { fetchPlan } from "@/lib/api";
import type { Plan } from "@/lib/types";

/**
 * plan_source_id からプランをロード。
 * fetchPlan は副作用として BE 側で session を seed し、session_id を返す。
 */
export function usePlan(planSourceId: string | null) {
  const { apiUrl } = useApiContext();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!planSourceId) return;
    let cancelled = false;

    fetchPlan(apiUrl, planSourceId)
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
  }, [apiUrl, planSourceId]);

  return { plan, error };
}
