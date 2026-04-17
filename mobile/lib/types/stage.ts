import type { components } from "@/lib/api/schema";
import type { Block } from "./blocks";

/**
 * BE の /periodic / /chat SSE `event: stage` ペイロード。
 * openapi-typescript で自動生成された型をベースに、blocks だけ手書きの Block union で上書き
 * (BE 側は dict[] として spec 化されているため、ここで型を絞る)。
 */
export type StageEvent = Omit<components["schemas"]["StageEvent"], "blocks"> & {
  blocks: Block[];
};
