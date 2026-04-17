import type { Plan } from "@/lib/types";

import { getJson, postJson } from "./client";
import type { components } from "./schema";

type PlanGenerateRequest = components["schemas"]["PlanGenerateRequest"];

export function fetchPlan(apiUrl: string, sourceId: string): Promise<Plan> {
  return getJson<Plan>(`${apiUrl}/guide/plan/${sourceId}`);
}

export function generatePlan(apiUrl: string, goal: string): Promise<Plan> {
  const body: PlanGenerateRequest = { goal };
  return postJson<Plan>(`${apiUrl}/guide/plan/generate`, body);
}
