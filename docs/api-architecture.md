# Backend アーキテクチャ

軽量DDD + 統一2段階パイプライン。

API 仕様の詳細は `GET /docs` (FastAPI 自動生成) を参照。

---

## レイヤー構成

```
routes/              ← HTTP受け口 (薄い、バリデーションのみ)
  guide_router.py

application/guide/   ← ユースケース (オーケストレーション)
  judge_use_case.py  → LangGraph 経由で Pipeline
  chat_use_case.py   → Pipeline 直接
  plan_use_case.py   → RAG + LLM
  blocks.py          ← UIブロック型
  schemas.py         ← Request/Response スキーマ

domain/guide/        ← ビジネスルール (外部依存なし)
  model.py           ← PlanStep, Feedback, SAFETY_KEYWORDS, sanitize_llm_output
  service.py         ← プロンプト構築 (Prompt定数 → render)
  prompt_loader.py   ← mdファイル読み込み + バージョン管理
  prompts/           ← バージョン付きプロンプト (*.md)

infrastructure/      ← 外部システム接続
  session/
    store.py         ← ValkeySessionStore (Valkey/Redis)
    models.py        ← Session dataclass
  agent/
    pipeline.py      ← 統一2段階パイプライン (全LLM処理の中心)
    graph.py         ← LangGraph (observe→think→safety→act)
    tools.py         ← LangChain @tool
  llm/
    base.py          ← LLMClient Protocol + BaseLangChainClient
    ollama.py        ← OllamaClient / OllamaHQClient
    factory.py       ← get_llm_client() / get_hq_llm_client()
  rag/
    milvus.py        ← MilvusRAGClient (14フィールドスキーマ)
    hybrid.py        ← HybridSearchClient (Dense + BM25 → RRF)
    bm25.py          ← BM25 日本語bi-gram
    embeddings.py    ← EmbeddingClient (nomic-embed-text)
  repositories/
    plan_repository.py     ← 静的JSON読み込み
    feedback_repository.py ← SQLite

common/              ← 横断ユーティリティ
  telemetry.py       ← OpenTelemetry 初期化
  metrics.py         ← OTel instruments + /metrics集計
  json_utils.py      ← extract_json_object / extract_json_array
  exceptions.py
```

---

## リクエストフロー

### /judge (定期判定)

```
guide_router.py
  → _validate_image (10MB, JPEG/PNG/WebP, 768px リサイズ)
  → Valkey: session 取得 (session_id)
  → JudgeUseCase.judge(image, session)
    → graph.ainvoke(GuideState)  ← session からコンテキスト自動注入
      → observe → think → run_two_stage_pipeline(periodic)
      → safety_check → act
    → JudgeResponse
  → session 更新 (observations, step 進行, コスト)
  → Valkey: session 保存
```

### /chat (ユーザー対話)

```
guide_router.py
  → Valkey: session 取得 (session_id)
  → ChatUseCase.chat(message, image, session)
    → session から chat_history, step 情報を自動取得
    → run_two_stage_pipeline(user_action)
    → ChatResponse
  → session 更新 (chat_history, コスト)
  → Valkey: session 保存
```

### /plan/generate (プラン自動生成)

```
guide_router.py
  → PlanGenerateUseCase.generate()
    → RAG検索 (top 15)
    → 動画ID別にグループ化 → 各ソースの全ステップ取得
    → Multi-Document Synthesis (LLM)
    → メモリキャッシュに保存
    → PlanResponse
```

---

## 依存注入 (dependencies.py)

```python
# FastAPI Depends() でシングルトン管理
get_guide_service()        → GuideService
get_rag_client()           → MilvusRAGClient | None
get_embedding_client()     → EmbeddingClient | None
get_hybrid_client()        → HybridSearchClient | None

get_session_store()        → ValkeySessionStore (シングルトン)
get_judge_use_case()       → JudgeUseCase (llm + hq + rag + embedding)
get_chat_use_case()        → ChatUseCase  (llm + hq + rag + embedding)
get_plan_generate_use_case() → PlanGenerateUseCase (hq + rag + embedding)
```

---

## エンドポイント一覧

| メソッド | パス | 入力 | 用途 |
|---------|------|------|------|
| POST | `/guide/plan/generate` | goal, mode | プラン生成 + **session_id 発行** |
| GET | `/guide/plan/{source_id}` | — | プラン取得 + **session_id 発行** |
| POST | `/guide/judge` | **session_id** + image | 自律判定 |
| POST | `/guide/chat` | **session_id** + message (+ image) | ユーザー対話 |
| POST | `/guide/analyze/stream` | image + mode | 手動解析 (SSE, セッション不要) |
| POST | `/guide/feedback` | sentiment, source | フィードバック |
| GET | `/metrics` | — | パイプラインメトリクス |

---

## 設定 (config.py)

```python
# LLM
llm_provider: "ollama" | "anthropic"
ollama_model: str        # fast (e2b)
ollama_hq_model: str     # deep (将来: 26b or Claude)

# Valkey
redis_url: "redis://localhost:6379/0"
session_ttl_sec: 1800    # 30分

# ハーネス
pipeline_timeout_periodic: 10.0      # 秒
pipeline_timeout_user_action: 20.0
session_max_stage2_calls: 30
session_max_total_calls: 500
max_response_length: 500             # 文字
max_blocks_per_response: 5
```
