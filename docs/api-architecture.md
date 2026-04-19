# Backend アーキテクチャ

FastAPI + 軽量 DDD。

エージェントは **LangGraph 単一グラフ** + **Structured Output** +
**Redis Checkpointer** で構成。`/periodic` / `/chat` は SSE ストリーミング。

API 仕様の詳細は起動後 `GET /docs` (FastAPI 自動生成 Swagger) を参照。
OpenAPI spec は `GET /openapi.json`、モバイルは `make gen-api` で TS 型を生成。

---

## レイヤー構成

```
routes/                      HTTP 受け口 (薄い: 入力検証 + UseCase 呼び出し + SSE ラップ)
  guide_router.py

application/guide/           業務ロジック
  usecases/                  UseCase = オーケストレーション (ルータから呼ぶ入口)
    periodic_use_case.py     /periodic: agent.run_periodic の薄いラッパ
    chat_use_case.py         /chat: ephemeral seed + agent.run_chat
    session_use_case.py      /session/start: agent.seed_session
    plan_query_use_case.py   /plan/{id}: repo 検索 + seed + DTO 組み立て
    plan_use_case.py         /plan/generate: RAG + LLM でステップ生成
    analyze_use_case.py      /analyze/stream: 1-shot (セッション不要)
    feedback_use_case.py     /feedback: SQLite 永続化
  schemas/                   Pydantic 型定義 (UseCase と infra が共有)
    api.py                   API Request/Response
    sse_schemas.py           SSE ペイロード型 (OpenAPI 露出用)
    outputs.py               Stage1Output / Stage2Output / CalibrationOutput
    blocks.py                UI ブロック型 (Text/Image/Video/Timer/Alert)

domain/guide/                ビジネスルール (フレームワーク非依存)
  model.py                   PlanStep, Feedback, check_step_safety, sanitize_llm_output
  service.py                 GuideService (プロンプト構築のみ)
  prompt_loader.py           md ファイル読み込み + バージョン管理
  prompts/                   バージョン付きプロンプト (periodic_stage1/v1.md 等)

infrastructure/              外部システム接続
  agent/
    graph.py                 GuideGraph (StateGraph 本体 + 全ノード)
    agent.py                 AgentClient (Graph の入口、LLMClient と同層)
    tools.py                 LangChain @tool (content_and_artifact)
  llm/
    base.py                  LLMClient Protocol + BaseLangChainClient
                             (call_structured, call_react_agent, prompt caching)
    ollama.py                OllamaClient / OllamaHQClient
    claude.py                ClaudeClient (cache_control 有効)
    factory.py               get_llm_client / get_hq_llm_client
  rag/
    milvus.py                MilvusRAGClient
    hybrid.py                HybridSearchClient (Dense + BM25 → RRF)
    bm25.py                  日本語 bi-gram BM25
    embeddings.py            nomic-embed-text
  repositories/
    plan_repository.py       静的 JSON (static/manual/)
    feedback_repository.py   SQLite

common/                      横断
  telemetry.py               OpenTelemetry 初期化
  metrics.py                 OTel instruments + /metrics 集計
  json_utils.py              extract_json_array (プラン生成のみ)
  exceptions.py              DomainException / ValidationError / LLMError /
                             AgentError / SessionError
```

---

### セッション管理

- **1 モード = 1 セッション**: 探索/プラン のモード選択画面 (モバイル) で `/session/start`
  を **1 回**呼んで `session_id` を採番。撮影中はそれを各 API に渡し続ける。
  「戻る」でメインに戻った時点でクライアントは session_id を破棄 → 以降は Redis TTL
  (30 分) で自動失効。
- **サーバ側は採番せず注入のみ**: `/plan/{id}` / `/plan/generate` は
  `agent.inject_plan_steps()` で既存 session に plan_steps を上書き。
  探索モード中の `chat_history` は state に残り続ける。
- **session_id 必須**: `/chat` `/periodic` `/plan/*` は session_id なしだと 422。
  `/session/start` のみ採番用で引数なし。

---

### SSE プロトコル (`/periodic` と `/chat` 共通)

```
event: stage
data: {"stage":1,"escalated":true,"message":"少し調べますね","blocks":[]}

event: stage
data: {"stage":2,"judgment":"next","message":"...","blocks":[...]}

event: done
data: {"current_step_index":2}
```

Stage1 の中間通知 (escalated=true) は stage2 の裏で流して UX 改善、最終判定は safety
ノードが emit。

---

## リクエストフロー

### /guide/periodic (自律監視)

```
routes/guide_router.py
  → _validate_image (MIME/10MB/768px リサイズ)
  → PeriodicUseCase.astream(session_id, image_bytes, stage1_result?)
      └─ agent.run_periodic(config={pipeline_type:"periodic", ...})
            └─ GuideGraph.astream(stream_mode=["custom","values"])
                  ├─ entry → route_entry (calibration / seed_stage1 / stage1)
                  ├─ stage1: llm.call_structured(Stage1Output)
                  │     → escalated なら中間 SSE emit
                  ├─ stage2 (escalated 時のみ):
                  │     llm.call_react_agent(Stage2Output, hq_tools)
                  │     → ToolMessage.artifact から blocks 回収
                  └─ safety: apply_safety + session 更新 + 最終 SSE emit
  → ルータは (event, data) タプルを SSE フォーマットで転送
```

**state は Checkpointer で自動永続化** (thread_id = session_id)。画像 bytes は
`config.configurable` 経由 = Redis に焼き付かない。

### /guide/chat (ユーザー対話)

```
routes/guide_router.py
  → _validate_image (任意)
  → ChatUseCase.astream(session_id, user_message, image_bytes?)
      └─ agent.run_chat(config={pipeline_type:"user_action", ...})
            └─ 以下 /periodic と同じ Graph (pipeline_type が user_action)
```

session_id は必須 (/session/start で採番済み)。/periodic と同じ Graph を pipeline_type
だけ切り替えて呼ぶ。history は state の `chat_history` に safety ノードで append。

### /guide/plan/{source_id}?session_id=...

```
routes/guide_router.py
  → PlanQueryUseCase.get(source_id, session_id)
      ├─ load_plan (SQLite/JSON)
      ├─ 404 → SessionError (http_status=404 に自動変換)
      └─ agent.inject_plan_steps(session_id, plan_source_id, plan_steps)
            └─ graph.aupdate_state(config, {plan_steps, ...})
               ↑ 既存 Checkpointer 上書き (chat_history 等は保持)
```

### /guide/plan/generate

```
routes/guide_router.py
  → PlanQueryUseCase.generate_and_inject(goal, session_id, generate_uc)
      ├─ PlanGenerateUseCase.generate(goal) → (PlanResponse, list[PlanStep])
      │     ├─ RAG 検索 (top 15) + Multi-Document Synthesis プロンプト
      │     └─ HQ モデル生成 → extract_json_array で steps 化
      └─ agent.inject_plan_steps (上と同じ)
```

---

## エラー処理

### ドメイン例外階層 (`common/exceptions.py`)

```python
DomainException           # 基底。http_status 属性を持つ
├─ ValidationError        # http 400
├─ LLMError               # http 502
├─ AgentError             # http 500
└─ SessionError           # http 404
```

`main.py` で 1 個のハンドラが `exc.http_status` を読んで JSON レスポンスに変換。
ルータ/UseCase は HTTPException ではなくこれら DomainException を投げる。

---

## 設定 (`config.py`)

```python
# LLM
llm_provider: "ollama" | "anthropic"       # 高速版
hq_provider: "ollama" | "anthropic" | ""   # 空なら llm_provider にフォールバック
ollama_model / ollama_hq_model
anthropic_model

# Redis (Checkpointer)
redis_url: "redis://localhost:6379/0"
session_ttl_min: 30                        # 分単位 (langgraph-checkpoint-redis)

# Harness
pipeline_timeout_periodic: 30.0            # 秒
pipeline_timeout_user_action: 60.0
session_max_stage2_calls: 30
session_max_total_calls: 500
max_response_length: 500                   # 文字
max_blocks_per_response: 5
```

---

## ランタイム要件

| コンポーネント | 要求 |
|---|---|
| Python | 3.12+ |
| **Redis** | **8.0+** (RedisJSON / RediSearch モジュール必須)。`redis/redis-stack-server` コンテナが楽 |
| Ollama | 任意 (llm_provider=ollama のとき) |
| Milvus | 任意 (milvus_db_path のファイル存在で有効化、なければ RAG 無効) |

Redis Stack 起動:
```bash
docker run -d --name redis-stack --restart unless-stopped \
  -p 6379:6379 redis/redis-stack-server:latest
```

---

## 観測性

| instrument | 内容 |
|---|---|
| `pipeline.run` span | グラフ全体 |
| `pipeline.stage1` span | Stage1 (latency, judgment, can_handle, escalate) |
| `pipeline.stage2` span | Stage2 (latency, escalation_reason, artifacts) |
| `pipeline.calls` counter | 呼び出し数 |
| `pipeline.escalations` counter | エスカレーション数 |
| `pipeline.latency_ms` histogram | レイテンシ分布 |

### LangSmith

```bash
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=lsv2_pt_xxx
LANGCHAIN_PROJECT=guidey
```
環境変数 3 行で各ノード単位のトレースが見られる。

---

## 開発コマンド (ルート Makefile)

```bash
make install        # uv sync + npm install
make dev            # Redis + BE (モバイルは別: make dev-mobile)
make gen-api        # OpenAPI → mobile/lib/api/schema.ts
make lint           # ruff check + expo lint
make format         # ruff format/--fix + expo lint --fix
make typecheck      # pyright + tsc --noEmit
make check          # lint + typecheck (CI 用)
```
