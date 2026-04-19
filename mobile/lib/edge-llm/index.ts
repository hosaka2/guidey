import { CloudStage1Runner } from "./cloud";
import { GemmaLocalRunner } from "./gemma-local";
import type { EdgeMode, Stage1Runner } from "./types";

export type {
  EdgeMode,
  EdgeStep,
  Stage1Input,
  Stage1Output,
  Stage1Runner,
} from "./types";
export { buildEdgePrompt } from "./types";

const _runners: Partial<Record<EdgeMode, Stage1Runner>> = {};

export function getStage1Runner(mode: EdgeMode): Stage1Runner {
  let r = _runners[mode];
  if (!r) {
    r = mode === "gemma-local" ? new GemmaLocalRunner() : new CloudStage1Runner();
    _runners[mode] = r;
  }
  return r;
}

export async function disposeAllRunners(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const [mode, r] of Object.entries(_runners)) {
    if (r) pending.push(r.dispose());
    delete _runners[mode as EdgeMode];
  }
  await Promise.allSettled(pending);
}
