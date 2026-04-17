# 自律エージェント アーキテクチャ

Guidey の LLM エージェントは **LangGraph の単一グラフ** で全フローを宣言的に記述し、
**Structured Output** で型安全に、**`create_react_agent`** で Stage2 のツールループを委譲する。

---

## 全体像

```
┌─ Mobile ────────────────────────────────────────────────────┐
│  useAutonomousLoop / explore: SSE を受信して UI を更新         │
│    POST /periodic (session_id + image [+ stage1_result?])       │
│    POST /chat  (session_id + msg  [+ stage1_result?])        │
│                                        → SSE: stage → done   │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP (session_id = thread_id)
┌─ Backend ────────────┴──────────────────────────────────────┐
│                                                              │
│   ┌─ GuideGraph (LangGraph StateGraph) ───────────────────┐ │
│   │                                                        │ │
│   │   START → entry ┬─ is_calibration?   → calibrate ──► END│
│   │                 ├─ precomputed_stage1? → seed_stage1 ─┐│ │
│   │                 └─ 通常               → stage1 ──────┤│ │
│   │                                                      ││ │
│   │                           (escalated?)               ││ │
│   │                           ├─ yes → stage2 ─┐         ││ │
│   │                           └─ no  ──────── safety ──► END│
│   │                                                        │ │
│   │   stage1:       call_structured(Stage1Output)          │ │
│   │   seed_stage1:  エッジ LLM 結果を state に hydrate      │ │
│   │   stage2:       call_react_agent(Stage2Output, tools)  │ │
│   │   safety:       ガード + メモリ更新 + 最終 SSE emit      │ │
│   │   calibrate:    call_structured(CalibrationOutput)     │ │
│   │                                                        │ │
│   │   SSE: get_stream_writer() → astream(custom,values)    │ │
│   └────────────────────────────────────────────────────────┘ │
│                                                              │
│   AsyncRedisSaver (Redis 8+): thread_id=session_id で       │
│   state を自動永続化。TTL 30 分 + refresh_on_read。           │
└──────────────────────────────────────────────────────────────┘
```

---

## 設計原則

| 原則 | 具体 |
|---|---|
| **単一グラフ** | `/periodic` / `/chat` / calibration を 1 本のグラフで。入り口で分岐 |
| **Structured Output 一貫** | Pydantic スキーマで LLM 出力を型付け。JSON 手動パース禁止 |
| **宣言的セーフティ** | `safety` ノードで最終判定を補正、メモリ更新も一元化 |
| **ツールは artifact で** | ブロック生成ツールは `response_format="content_and_artifact"` を使う |
| **state = メモリ** | LangGraph Checkpointer (Redis 8+) が thread_id ごとに自動永続化。手動 session store 不要 |
| **per-call 入力は config** | image_bytes / user_message は `config.configurable` 経由。state に焼き付かない |
| **エッジ準備**: stage1 差し替え可能 | `seed_stage1` ノードでクライアント持ち込みの Stage1Output を受け入れ |

---

## Graph の State

Checkpointer が `thread_id` (= session_id) ごとに永続化する。image_bytes などの
**per-call 一時入力は State に入れず config.configurable 経由で渡す** — Redis に
焼き付かないため、画像がセッション間で混入しない。

```python
class GuideGraphState(TypedDict, total=False):
    # --- セッションメタデータ (初回 seed で設定) ---
    pipeline_type: Literal["periodic", "user_action"]
    plan_steps: list[dict]        # JSON-safe dict で保存
    plan_source_id: str
    total_steps: int

    # --- 進捗 (変化する) ---
    current_step_index: int
    step_started_at: str          # ISO datetime、next 判定時に safety が更新

    # --- 短期メモリ (safety ノードで append) ---
    recent_observations: list[str]   # 直近 3 件
    chat_history: list[dict]         # 直近 10 件 [{role, content}]

    # --- コスト管理 ---
    total_calls: int
    stage2_calls: int

    # --- ノード出力スナップショット (毎ターン上書き) ---
    stage1: dict | None           # Stage1Output.model_dump()
    stage2: dict | None
    escalated: bool
    judgment: str
    confidence: float
    message: str
    blocks: list[dict]
```

### per-call 入力 (config)

```python
config = {"configurable": {
    "thread_id": session_id,           # Checkpointer のキー
    "image_bytes": bytes | None,
    "user_message": str | None,
    "is_calibration": bool,
    "precomputed_stage1": dict | None, # エッジ推論結果 (Stage1Output.model_dump())
}}
```

---

## ノード詳細

### `entry` (routing only)

```python
def route_entry(state) -> str:
    if state.get("is_calibration"):
        return "calibrate"
    return "stage1"
```

### `stage1` — 高速判定 (Structured Output)

- モデル: `OllamaClient` (Gemma4:e2b)、または将来 Apple Foundation Models / Gemini Nano
- 入力: 画像 + prompt (periodic / user_action / explore で内容違い)
- 出力: `Stage1Output { judgment, confidence, message, can_handle, escalation_reason }`
- `can_handle=false` ならエスカレーション → stage2
- 非エスカレーションで `message` があれば Proactive 声かけ

```python
async def stage1_node(state):
    prompt = build_stage1_prompt(state, guide_service)
    s1 = await llm_client.call_structured(
        system_prompt=prompt, schema=Stage1Output,
        image_bytes=state.get("image_bytes"),
    )
    escalated = should_escalate(s1, state["pipeline_type"])
    writer = get_stream_writer()
    if escalated:
        # 中間イベント: 「少し調べますね」を即配信、stage2 を待たせる
        writer({"stage": 1, "escalated": True,
                "message": s1.message or "少し調べますね。", ...})
    return {"stage1": s1, "escalated": escalated, ...}
```

### `stage2` — 深い推論 (LangGraph create_react_agent)

- モデル: `OllamaHQClient` or `ClaudeClient`
- ツール: `build_hq_tools()` で共通 + コンテキスト + RAG + プラン操作
- フロー: LangChain の ReAct ループ (bind_tools → tool_call → ToolMessage → ...)
- 最終出力: `Stage2Output { judgment, confidence, message }` + artifact 収集

```python
async def stage2_node(state):
    s1 = state["stage1"]
    prompt = build_stage2_prompt(state, s1.escalation_reason, guide_service)
    tools = build_hq_tools(...)
    s2, artifacts = await hq_client.call_react_agent(
        system_prompt=prompt, tools=tools,
        response_schema=Stage2Output,
        image_bytes=state.get("image_bytes"),
    )
    return {"stage2": s2, "blocks": artifacts,
            "judgment": s2.judgment, "message": s2.message, ...}
```

#### ツール artifact パターン

ブロック生成ツールは `content_and_artifact` を使う:

```python
@tool(response_format="content_and_artifact")
def set_timer(duration_sec: int, label: str) -> tuple[str, dict]:
    """タイマーをセットする"""
    block = TimerBlock(...).model_dump()
    return f"{label} を {duration_sec} 秒でセット", block  # (LLM可読, block)
```

`create_react_agent` 完了後、`ToolMessage.artifact` から block を回収:

```python
artifacts = [m.artifact for m in result["messages"]
             if isinstance(m, ToolMessage) and isinstance(m.artifact, dict)]
```

非 artifact ツール (`search_rag`, `modify_step`) は通常の文字列を返し、LLM が message に要約を書く。

### `safety` — 最終ガード

全経路が safety を通る。判定を補正し、最終イベントを emit。

```python
def safety_node(state):
    safe = apply_safety(
        judgment=state["judgment"],
        confidence=state["confidence"],
        message=state["message"],
        blocks=state["blocks"],
        plan_steps=state["plan_steps"],
        current_step_index=state["current_step_index"],
        current_step_duration_sec=state["current_step_duration_sec"],
    )
    writer = get_stream_writer()
    # 最終イベント: stage=2 if escalated else 1
    writer({
        "stage": 2 if state["escalated"] else 1,
        "escalated": state["escalated"],
        "judgment": safe["judgment"],
        "confidence": safe["confidence"],
        "message": safe["message"],
        "blocks": safe["blocks"],
        "current_step_index": state["current_step_index"],
    })
    return safe
```

#### `apply_safety` のルール

| 条件 | アクション |
|---|---|
| `judgment=next` + 次ステップに危険キーワード | AlertBlock 追加 + 警告 |
| `judgment=next` + 現ステップ < 15 秒滞在 | `continue` にダウングレード |
| `judgment=next` + 既に最終ステップ | `continue` + 「最後のステップです」 |
| `judgment=anomaly` + `confidence < 0.5` | `continue` にダウングレード |

### `calibrate` — 初期位置特定

ワンショット。プラン開始時にユーザーが既にどのステップにいるかを推定。

```python
async def calibrate_node(state):
    result = await calibrate(state["image_bytes"], state["plan_steps"], ...)
    writer = get_stream_writer()
    writer({"stage": 1, "judgment": "calibrated",
            "current_step_index": result["current_step_index"], ...})
    return result
```

---

## エッジ (edges)

```python
sg = StateGraph(GuideGraphState)
sg.add_node("stage1", stage1_node)
sg.add_node("stage2", stage2_node)
sg.add_node("safety", safety_node)
sg.add_node("calibrate", calibrate_node)

sg.add_conditional_edges(
    START, route_entry,
    {"calibrate": "calibrate", "stage1": "stage1"},
)
sg.add_conditional_edges(
    "stage1", after_stage1,
    {"stage2": "stage2", "safety": "safety"},
)
sg.add_edge("stage2", "safety")
sg.add_edge("safety", END)
sg.add_edge("calibrate", END)
```

### エスカレーション条件

| pipeline_type | 条件 | 設計意図 |
|---|---|---|
| `periodic` | `anomaly` + `can_handle=false` | 速度優先。continue/next は stage1 で確定 |
| `user_action` | `can_handle=false` | 正確性優先。常にエスカレーション可 |

目標エスカレーション率: periodic ≤ 5% / user_action 10-20%

---

## SSE ストリーミング

### Graph からの emission 方式

各ノードが `get_stream_writer()` で **明示的にイベントを書き込む**。
ルータは `astream(stream_mode=["custom", "values"])` で受け取って SSE に変換。

```
stage1 escalated=true  → writer({stage:1, escalated:true, message:"少し調べますね"})
                         [stage2 に進む、クライアントは待機]
stage2 完了              → [まだ emit しない]
safety 実行後            → writer({stage:2, escalated:true, judgment, message, blocks})

OR

stage1 escalated=false → [まだ emit しない]
safety 実行後            → writer({stage:1, escalated:false, judgment, message, blocks})
```

### プロトコル

```
event: stage
data: {"stage":1, "escalated":true, "message":"少し調べますね。", "blocks":[], ...}

event: stage
data: {"stage":2, "escalated":true, "judgment":"continue", "message":"...", "blocks":[...], "current_step_index":2}

event: done
data: {"current_step_index":2}
```

### ルータ実装

```python
@router.post("/periodic")
async def periodic(file, session_id, is_calibration, ...):
    initial = build_graph_state_from_session(session, image_bytes, is_calibration)

    async def event_gen():
        final_state = None
        async for mode, data in graph.astream(
            initial, stream_mode=["custom", "values"],
        ):
            if mode == "custom":
                yield f"event: stage\ndata: {json.dumps(data)}\n\n"
            elif mode == "values":
                final_state = data  # 最後まで上書き、最終状態を保持

        # 最終状態で session を更新
        if final_state:
            apply_session_update(session, final_state)
            await store.save(session)
        yield f"event: done\ndata: {...}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream")
```

### クライアントの inflight ガード

モバイル `useAutonomousLoop` の `isJudgingRef` が SSE 完了まで true のまま → 次の periodic tick は自動スキップ。サーバ側の inflight 排他は不要。

---

## エッジ LLM 計画 (Pattern A: 持ち込み)

### 現在

```
mobile → POST /periodic (image)
         BE graph: stage1 → [escalate?] → stage2 → safety → END
```

### 将来 (stage1 on-device)

```
mobile: ローカル推論 (Apple Foundation Models / Gemma 2B on-device)
   └─ POST /guide/periodic (or /chat)
        form-data: file + session_id + stage1_result={JSON}
      BE graph: seed_stage1 ノード経由 → (stage2 | safety) → END
      (stage1 ノードはスキップ、LLM 呼び出しなし)
```

### Graph の変更点

**すでに実装済み**: `seed_stage1` ノード + entry ルータ分岐。

```python
def route_entry(state, config):
    cfg = config["configurable"]
    if cfg.get("is_calibration"):
        return "calibrate"
    if cfg.get("precomputed_stage1"):   # クライアント持ち込み
        return "seed_stage1"
    return "stage1"
```

`seed_stage1` ノードは `stage1` と同じ出力構造を作って state に書き込み、
同じ `route_after_stage1` conditional で stage2 / safety に進む。

**ノード構造は不変**。compute (stage1) の実行場所が cloud ⇄ device で変わるだけ。
`Stage1Output` という共通契約があるから成立する。

### モバイル側の準備

| 項目 | 対応 |
|---|---|
| Stage1Output の型同期 | `outputs.py` を OpenAPI 経由 or 手動で TS に写す |
| エッジ推論モジュール | Apple Foundation Models / CoreML / MLX など |
| 推論プロンプトの同期 | `src/domain/guide/prompts/*` を同じ形式でモバイルに配布 |
| リクエスト組み立て | `stage1_result=JSON` を form-data に追加するだけ |

---

## LLM クライアント

### Protocol

```python
class LLMClient(Protocol):
    async def analyze_image(image_bytes, system_prompt) -> str: ...
    async def analyze_image_stream(image_bytes, system_prompt) -> AsyncIterator[str]: ...
    async def generate_text(system_prompt) -> str: ...

    async def call_structured(
        system_prompt: str, schema: type[T], image_bytes: bytes | None,
    ) -> T: ...

    async def call_react_agent(
        system_prompt: str, tools: list[BaseTool],
        response_schema: type[T], image_bytes: bytes | None,
    ) -> tuple[T, list[dict]]: ...  # (structured応答, artifactリスト)
```

### 実装

```
LLMClient (Protocol)
  └── BaseLangChainClient
       ├── OllamaClient (高速: Gemma4:e2b, num_ctx=4096, think=False)
       ├── OllamaHQClient (高品質: 将来 gemma4:26b or Claude 代替)
       └── ClaudeClient (Claude Sonnet)
```

`call_structured` は `_model.with_structured_output(schema)` を使用。
`call_react_agent` は `langgraph.prebuilt.create_react_agent` を使用。

### プロバイダー切り替え

`backend/.env`:
```bash
LLM_PROVIDER=ollama        # "ollama" or "anthropic"
OLLAMA_MODEL=gemma4:e4b
ANTHROPIC_MODEL=claude-sonnet-4-5-20250514
```

Factory パターンで自動選択:
- `get_llm_client()`: 高速版 (stage1)
- `get_hq_llm_client()`: 高品質版 (stage2)

---

## モデル使い分け

| 用途 | 頻度 | モデル選択 |
|---|---|---|
| **Stage1 判定** (periodic 3秒間隔) | 数百回/セッション | Gemma4:e4b (将来: edge) |
| **Stage2 推論** (エスカレーション時) | 5-20 回/セッション | Gemma4:e4b or Claude |
| **プラン生成** (セッション開始) | 1 回 | Gemma4:26b or Claude |
| **キャリブレーション** (開始直後) | 1 回 | Gemma4:e4b |
| **visual_marker 生成** (データ登録) | バッチ | Gemma4 VLM |

### コスト試算

| 運用 | Stage1 | Stage2 | プラン生成 | 月額 |
|---|---|---|---|---|
| ローカル (Ollama のみ) | ¥0 | ¥0 | ¥0 | **¥0** (電気代のみ) |
| ハイブリッド | ¥0 | ¥0 | Claude ~¥100 | **~¥100** |
| エッジ移行後 | ¥0 (on-device) | Claude ~¥50 | Claude ~¥100 | **~¥150** |

---

## セッション管理 (AsyncRedisSaver Checkpointer)

### 所有権: BE ソース・オブ・トゥルース

`langgraph-checkpoint-redis` の `AsyncRedisSaver` が graph state を Redis 8+ に自動永続化。
**Redis 8 以上が必須** (RedisJSON / RediSearch モジュールを内蔵するため)。

```python
checkpointer = AsyncRedisSaver(
    redis_url="redis://localhost:6379/0",
    ttl={"default_ttl": 30, "refresh_on_read": True},  # 30 分、アクセス延命
)
await checkpointer.asetup()  # 起動時 1 回、インデックス作成
graph = build_guide_graph(..., checkpointer=checkpointer)
```

### ライフサイクル

```
/plan/generate or /plan/{id}
  → session_id 発行 (UUID)
  → graph.aupdate_state(config, initial_state) で Redis に seed
      (plan_steps / plan_source_id / total_steps / current_step_index=0 など)
      ↓
/periodic or /chat
  → config={"configurable":{"thread_id":session_id, "image_bytes":..., ...}}
  → graph.astream(None, config, stream_mode=["custom","values"])
     (None = 既存 state を継承、入力なし)
  → 各ノードが state を更新、Checkpointer が自動保存
  → safety ノードで observation/chat_history/step advance を一元更新
      ↓
30 分無操作 → TTL 自動揮発 (refresh_on_read で読み取りごとに延命)
```

### 設計判断

| 判断 | 理由 |
|---|---|
| **Redis 8** を必須化 | `langgraph-checkpoint-redis` が RedisJSON/RediSearch を要求。Valkey 不可 (モジュール非内蔵) |
| Session dataclass 廃止 | Graph state に集約。手動 JSON serialize/deserialize が消える |
| per-call を config 経由 | image_bytes が checkpoint に残らない (プライバシー & サイズ) |
| safety ノードで memory 更新 | 副作用を 1 箇所に集約、トランザクション的に確実 |

---

## ハーネス (安全装置)

| Layer | 内容 |
|---|---|
| **0. 入力ガード** (ルータ) | 画像 10MB / JPEG,PNG,WebP / 768px リサイズ |
| **1. コスト上限** (graph entry) | `session_max_total_calls=500` / `stage2_calls=30` 超過 → continue |
| **2. タイムアウト** (graph entry) | periodic 10s / user_action 20s (`asyncio.timeout`) |
| **3. Structured Output** | スキーマ検証で不正応答を排除 (Pydantic validate) |
| **4. 出力サニタイズ** (safety 後) | メッセージ長 500 / blocks 5 / injection 対策 / URL 検証 |
| **5. Safety ノード** | 危険キーワード / 最低滞在時間 / 低確信度 anomaly / 最終ステップ |
| **6. Mobile ハーネス** | 適応的サンプリング / stuck 検知 / Lock / TTS 競合管理 |

全層のデフォルトは `judgment=continue` (現状維持)。発動しても進めず戻す。

---

## 観測性

### OpenTelemetry

| Instrument | 内容 |
|---|---|
| `graph.run` span | グラフ全体 (pipeline_type, has_image, is_calibration, total_ms) |
| `graph.stage1` span | Stage1 (latency_ms, judgment, confidence, escalated) |
| `graph.stage2` span | Stage2 (latency_ms, escalation_reason, tool_count, artifacts) |
| `graph.safety` span | Safety (override, reason) |
| `pipeline.calls` counter | 呼び出し数 |
| `pipeline.escalations` counter | エスカレーション数 |
| `pipeline.latency_ms` histogram | レイテンシ分布 |

### LangSmith

環境変数 3 行で自動トレース。LangGraph の各ノード単位で可視化される:

```bash
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=lsv2_pt_xxx
LANGCHAIN_PROJECT=guidey
```

### `graph.get_graph().draw_mermaid()`

グラフ構造をそのまま図に吐ける (ドキュメント・デバッグ用途)。

---

## プロンプト管理

バージョン付き md で一元管理:

```
src/domain/guide/prompts/
  periodic_stage1/v1.md     ← 定期判定
  user_action_stage1/v1.md  ← ユーザー対話 (プランあり)
  explore_stage1/v1.md      ← 探索モード (プランなし)
  stage2_escalation/v1.md   ← 共通 Stage2 (ツール利用)
  calibration/v1.md         ← キャリブレーション
  plan_generation/v1.md     ← プラン自動生成
  analyze_oneshot/v1.md     ← 1ショット解析
```

```python
from src.domain.guide.prompt_loader import Prompt, render
render(Prompt.PERIODIC_STAGE1, step_number="3", ...)
```

バージョン切り替えは `PROMPT_VERSIONS` 定数のみ。

---

## Mobile: 結果表示ルール

| イベント | 指示カード | ブロックカード | TTS |
|---|---|---|---|
| `stage=1, escalated=true` (中間) | 変更なし | TextBlock (Proactive) | advise |
| `stage=1, judgment=continue` | 変更なし | message があれば TextBlock | advise |
| `stage=1, judgment=next` | **ステップ更新** | blocks | transition |
| `stage=1, judgment=anomaly` | 変更なし | AlertBlock | warn (割り込み) |
| `stage=2, judgment=*` | 同上 (stage1 と同じ規則) | blocks (artifacts 含む) | respond |

**指示カードは「今やるべきこと」を常に保持**。anomaly やチャット応答で上書きしない。

---

## ファイル構成

```
backend/src/
├── common/
│   ├── telemetry.py           # OpenTelemetry 初期化
│   └── metrics.py             # OTel instruments + /metrics 集計
├── domain/guide/
│   ├── model.py               # PlanStep, safety rules, sanitize
│   ├── service.py             # プロンプト構築 (Prompt 定数経由)
│   ├── prompt_loader.py       # md 読み込み + バージョン管理
│   └── prompts/               # バージョン付き md
├── application/
│   ├── dependencies.py        # DI (get_checkpointer / get_guide_graph シングルトン)
│   └── guide/
│       ├── outputs.py         # Stage1Output / Stage2Output / CalibrationOutput
│       ├── blocks.py          # UIブロック型 (Text/Image/Video/Timer/Alert)
│       ├── plan_use_case.py   # プラン生成 (graph とは独立)
│       └── schemas.py         # API Pydantic (Plan, Feedback 等)
├── infrastructure/
│   ├── agent/
│   │   ├── graph.py           # ★ GuideGraph 本体: state + 全ノード + build_guide_graph
│   │   └── tools.py           # LangChain @tool + artifact
│   └── llm/
│       ├── base.py            # LLMClient Protocol + BaseLangChainClient
│       │                      #   call_structured / call_react_agent
│       ├── ollama.py          # OllamaClient / OllamaHQClient
│       ├── claude.py          # ClaudeClient
│       └── factory.py         # プロバイダー選択

mobile/
├── hooks/
│   ├── useAutonomousLoop.ts   # 自律ループ (SSE 受信)
│   ├── useAgentState.ts       # Lock + TTS 競合管理
│   ├── useSpeechRecognition.ts
│   └── useJudgeApi.ts         # callJudgeStream / callChatStream (XHR 経由 SSE)
├── components/
│   ├── BlockRenderer.tsx      # ブロック描画
│   └── blocks/                # Text/Image/Video/Timer/Alert
└── types/
    ├── blocks.ts
    └── plan.ts
```
