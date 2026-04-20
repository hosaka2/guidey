import { buildEdgePrompt } from "./prompts";
import type { Stage1Input, Stage1Output, Stage1Runner } from "./types";
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
  // llama.rn 0.12+ は initLlama の mmproj を受け付けず、別途 initMultimodal を呼ぶ必要がある。
  initMultimodal?: (opts: {
    path: string;
    use_gpu?: boolean;
    image_max_tokens?: number;
  }) => Promise<boolean>;
};

type LlamaRn = {
  initLlama: (opts: {
    model: string;
    mmproj?: string;
    n_ctx: number;
    n_gpu_layers?: number;
    /** llama.rn 0.12+: Metal を完全に無効化 (iOS での Metal 不具合回避)。 */
    no_gpu_devices?: boolean;
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
      // llama.rn 0.12+ は mmproj を initLlama ではなく initMultimodal で指定する。
      try {
        this.ctx = await llama.initLlama({
          model: stripFilePrefix(paths.main),
          n_ctx: 2048,
          n_gpu_layers: 99,
        });
        console.log(`[edge/gemma] context ready in ${Date.now() - t0}ms (GPU)`);
      } catch (e) {
        console.warn("[edge/gemma] GPU init failed, retry with CPU:", e);
        this.ctx = await llama.initLlama({
          model: stripFilePrefix(paths.main),
          n_ctx: 2048,
          n_gpu_layers: 0,
          no_gpu_devices: true,
        });
        console.log(`[edge/gemma] context ready in ${Date.now() - t0}ms (CPU)`);
      }

      // Multimodal (vision) 有効化
      if (this.ctx.initMultimodal) {
        try {
          const ok = await this.ctx.initMultimodal({
            path: stripFilePrefix(paths.mmproj),
            use_gpu: true,
            image_max_tokens: 512,
          });
          console.log(`[edge/gemma] initMultimodal result: ${ok}`);
        } catch (e) {
          console.warn("[edge/gemma] initMultimodal failed:", e);
        }
      }
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
  // 小型モデル (SmolVLM 500M 等) は JSON 形式を守らず自然言語で返すことが多い。
  // まず JSON 抽出を試み、失敗したらキーワードベースのヒューリスティクスに落とす。
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      return {
        judgment:
          obj.judgment === "next" || obj.judgment === "anomaly" ? obj.judgment : "continue",
        confidence: Math.max(0, Math.min(1, Number(obj.confidence) || 0.5)),
        message: String(obj.message ?? ""),
        can_handle: obj.can_handle !== false,
        escalation_reason: String(obj.escalation_reason ?? ""),
      };
    } catch {
      // fallthrough to heuristic
    }
  }

  // --- ヒューリスティクスフォールバック ---
  // JSON で返せなかった場合、自然言語応答のキーワードから judgment を推定。
  // 自信度は低く (0.3) can_handle=false にして BE エスカレーションを促す。
  const lower = raw.toLowerCase();
  const anomalyHit = /(danger|warning|stop|危険|異常|違う|間違|焦|煙|火|こぼ|burn|smoke|wrong)/i.test(
    raw,
  );
  const nextHit = /(完了|終わ|次へ|done|finished|complete|ok|good|次)/i.test(raw) && !anomalyHit;
  const judgment: Stage1Output["judgment"] = anomalyHit
    ? "anomaly"
    : nextHit
      ? "next"
      : "continue";
  const message = raw.replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    judgment,
    confidence: 0.3,
    message,
    can_handle: false, // 判定信頼性低いので BE エスカレーション
    escalation_reason: `edge parse heuristic (lower=${lower.slice(0, 80)}...)`,
  };
}
