import { buildEdgePrompt, type Stage1Input, type Stage1Output, type Stage1Runner } from "./types";
import { downloadModel, isModelReady, modelPaths } from "./model-manager";

/**
 * llama.rn + Gemma 4 E2B (VLM) をオンデバイス実行する Stage1Runner。
 *
 * - 本体 (Q4_K_M) + mmproj-F16 をペアでロード
 * - 画像 file:// URI を completion({ media_paths }) で渡す
 * - JSON 出力を stop トークンで最短停止、パース失敗時は null フォールバック
 */

type CompletionOpts = {
  prompt: string;
  n_predict: number;
  temperature?: number;
  stop?: string[];
  media_paths?: string[];
};

type LlamaContext = {
  completion: (opts: CompletionOpts) => Promise<{ text: string }>;
  release: () => Promise<void>;
};

type LlamaRn = {
  initLlama: (opts: {
    model: string;
    mmproj?: string;
    n_ctx: number;
    n_gpu_layers?: number;
  }) => Promise<LlamaContext>;
};

function loadLlamaRn(): LlamaRn | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("llama.rn") as LlamaRn;
  } catch (e) {
    console.warn("[edge/gemma] llama.rn not installed", e);
    return null;
  }
}

function stripFilePrefix(uri: string): string {
  return uri.startsWith("file://") ? uri.slice(7) : uri;
}

export class GemmaLocalRunner implements Stage1Runner {
  private ctx: LlamaContext | null = null;
  private loading: Promise<void> | null = null;

  isReady(): boolean {
    return this.ctx !== null;
  }

  async prepare(): Promise<void> {
    if (this.ctx) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const llama = loadLlamaRn();
      if (!llama) throw new Error("llama.rn not available");

      if (!(await isModelReady())) {
        console.log("[edge/gemma] downloading bundle...");
        await downloadModel((p) => {
          if (Math.round(p.percent) % 10 === 0) {
            console.log(`[edge/gemma] dl ${p.asset} ${p.percent.toFixed(0)}%`);
          }
        });
      }

      const paths = modelPaths();
      console.log("[edge/gemma] loading context:", paths);
      const t0 = Date.now();
      this.ctx = await llama.initLlama({
        model: stripFilePrefix(paths.main),
        mmproj: stripFilePrefix(paths.mmproj),
        n_ctx: 2048,
        n_gpu_layers: 99,
      });
      console.log(`[edge/gemma] context ready in ${Date.now() - t0}ms`);
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async run(input: Stage1Input): Promise<Stage1Output | null> {
    if (!this.ctx) {
      console.warn("[edge/gemma] not ready, falling back to cloud");
      return null;
    }
    const prompt = buildEdgePrompt(input);
    const t0 = Date.now();
    let raw = "";
    try {
      const res = await this.ctx.completion({
        prompt,
        n_predict: 256,
        temperature: 0.1,
        stop: ["}\n", "}\r\n", "\n\n"],
        media_paths: [stripFilePrefix(input.imageUri)],
      });
      raw = (res.text || "").trim();
      if (!raw.endsWith("}")) raw += "}";
      const parsed = parseStage1Json(raw);
      const dt = Date.now() - t0;
      console.log(
        `[edge/gemma] j=${parsed.judgment} conf=${parsed.confidence.toFixed(2)} can_handle=${parsed.can_handle} msg='${(parsed.message || "").slice(0, 40)}' dt=${dt}ms`,
      );
      return parsed;
    } catch (e) {
      console.warn("[edge/gemma] inference failed:", e, "raw:", raw.slice(0, 120));
      return null;
    }
  }

  async dispose(): Promise<void> {
    if (this.ctx) {
      try {
        await this.ctx.release();
      } catch {
        /* noop */
      }
      this.ctx = null;
      console.log("[edge/gemma] disposed");
    }
  }
}

function parseStage1Json(raw: string): Stage1Output {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const body = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  const obj = JSON.parse(body);
  return {
    judgment:
      obj.judgment === "next" || obj.judgment === "anomaly" ? obj.judgment : "continue",
    confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0.5)),
    message: String(obj.message ?? ""),
    can_handle: obj.can_handle !== false,
    escalation_reason: String(obj.escalation_reason ?? ""),
  };
}
