import type { Plan } from "@/lib/types";

import { getJson, postJson } from "./client";
import type { components } from "./schema";

type PlanGenerateRequest = components["schemas"]["PlanGenerateRequest"];

export function fetchPlan(
  apiUrl: string,
  sourceId: string,
  sessionId: string,
): Promise<Plan> {
  const qs = new URLSearchParams({ session_id: sessionId }).toString();
  return getJson<Plan>(`${apiUrl}/guide/plan/${sourceId}?${qs}`);
}

export function generatePlan(
  apiUrl: string,
  goal: string,
  sessionId: string,
): Promise<Plan> {
  const body: PlanGenerateRequest = { goal, session_id: sessionId };
  return postJson<Plan>(`${apiUrl}/guide/plan/generate`, body);
}
