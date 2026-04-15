export type PlanStep = {
  step_number: number;
  text: string;
  visual_marker: string;
  frame_url: string;
};

export type Plan = {
  source_id: string;
  title: string;
  steps: PlanStep[];
};

import type { Block } from "./blocks";

export type JudgeResponse = {
  judgment: "continue" | "next" | "anomaly";
  confidence: number;
  message: string;
  current_step_index: number;
  blocks: Block[];
  escalated: boolean;
};
