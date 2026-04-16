# 自律エージェント アーキテクチャ

---

## 全体像

```
┌─ Mobile ─────────────────────────────────────────────┐
│  useAutonomousLoop (3秒間隔、適応的)                    │
│    POST /judge (session_id + image のみ)               │
│  useSpeechRecognition → POST /chat (session_id + msg)  │
└──────────────────────┬───────────────────────────────┘
                       │ REST API (session_id ベース)
┌─ Backend ────────────┴───────────────────────────────┐
│  Valkey: session:{id} → コンテキスト全管理              │
│  /judge → session取得 → LangGraph → Pipeline → session更新 │
│  /chat  → session取得 → Pipeline → session更新           │
│                                                       │
│  LangGraph: observe → think (pipeline) → safety → act  │
│  Pipeline:  Stage 1 (fast) → [escalate?] → Stage 2    │
└───────────────────────────────────────────────────────┘
```

---

## 統一2段階パイプライン

定期判定 (periodic) とユーザー対話 (user_action) が**同じ関数**を共有。

```python
result = await run_two_stage_pipeline(
    input_data=PipelineInput(pipeline_type="periodic", ...),  # or "user_action"
    guide_service=..., llm_client=..., hq_client=...,
)
```

### Stage 1 (fast): Gemma e2b, ~1s
- 定期判定: 3択 (continue/next/anomaly) + Proactive声かけ
- ユーザー対話: 即応答 + ツール実行 (max_rounds=3)
- `can_handle` で自己判定

### Stage 2 (deep): HQ / Claude, ~3-5s
- エスカレーション時のみ実行
- RAG検索 + プラン修正 + ツール実行 (max_rounds=5)

### エスカレーション条件

| pipeline_type | 条件 | 設計意図 |
|---------------|------|---------|
| periodic | anomaly + can_handle=false | 速度優先。continue/next はスキップ |
| user_action | can_handle=false | 正確性優先。常にエスカレーション |

**目標エスカレーション率**: periodic 5%以下 / user_action 10-20%

---

## LangGraph State Machine

定期判定 (/judge) のフロー制御を担う。パイプラインへの橋渡し。

### ノード

| ノード | 役割 | LLM |
|--------|------|-----|
| **observe** | エントリポイント | なし |
| **think** | `run_two_stage_pipeline(periodic)` | Gemma + (HQ) |
| **safety_check** | 安全確認 (4層) | なし |
| **act** | ログ出力 | なし |

```
observe → think (pipeline) → safety_check → act → END
```

Appraise (意味的変化検知) は削除済み。LLM 2回呼び出しのオーバーヘッドが大きく、
think 自体が continue を返すことで同等の効果を得られるため。

---

## セッション管理 (Valkey)

Mobile は `session_id` + 画像/発話だけ送信。コンテキストは全て BE の Valkey セッションで管理。

### セッションライフサイクル

```
/plan/generate or /plan/{id}
  → session_id 発行 (UUID)
  → Valkey に保存 (TTL 30分)
  → レスポンスに session_id 含む
      ↓
/judge (session_id + image)
  → session 取得 → observations, step_duration 等を自動参照
  → 判定後: session.add_observation(), session.advance_step()
      ↓
/chat (session_id + message)
  → session 取得 → chat_history, step 情報を自動参照
  → 応答後: session.add_chat_message()
      ↓
30分無操作 → TTL 自動揮発
```

### Session データ構造

```python
Session:
  session_id, plan_source_id, created_at
  plan_steps: list[dict]       # ステップ一覧
  total_steps: int
  current_step_index: int      # BE が管理 (next 判定で +1)
  step_started_at: str         # 滞在時間計算用
  recent_observations: list    # 直近3件
  chat_history: list           # 直近10件
  total_calls, stage2_calls    # コスト管理
```

### 設計判断

| 判断 | 理由 |
|------|------|
| Valkey (Redis互換) | マルチワーカー対応、永続化不要だが共有が必要 |
| TTL 30分 | 作業セッションの平均時間。無操作で自動揮発 |
| JSON シリアライズ | Hash より単純。1 session = 1 key |
| ステップ進行は BE | Mobile は表示に専念。BE がsafety_check後にadvance |

---

## ハーネス (安全装置)

**設計原則: 安全なデフォルト** — 全てのハーネスが発動した時のデフォルトは `continue` (現状維持)。

### 7層構造

```
Layer 0: 入力ガード
  画像 10MB / JPEG,PNG,WebP / 768pxリサイズ / step_index 境界チェック

Layer 1: コスト上限
  session_max_total_calls: 500 / session_max_stage2_calls: 30
  超過 → continue + 利用上限メッセージ

Layer 2: タイムアウト
  periodic: 10s / user_action: 20s (asyncio.wait_for)
  タイムアウト → continue

Layer 3: 2段階パイプライン
  Stage 1 max_rounds=3 / Stage 2 max_rounds=5
  応答パース正規化 (confidence clamp, judgment正規化)

Layer 4: 出力サニタイズ
  メッセージ長 500文字 / ブロック数 5個
  injection対策 (javascript:, <script, prompt leak)
  URL検証 (http/https のみ)

Layer 5: 安全チェック (safety_check ノード)
  a. 危険キーワード検知 → AlertBlock (火, 刃物, 高所, 電気, 熱い)
  b. anomaly + conf < 0.5 → continue にダウングレード
  c. 最低滞在時間ガード → 直前ステップが10秒未満なら next ブロック
  d. 高速スキップ検知 → 連続2ステップが10秒未満 → AlertBlock
  e. 最終ステップ超え防止

Layer 6: Mobile ハーネス
  適応的サンプリング (3s → 10s → 20s)
  Stuck検知 (continue 15回 → 自動介入)
  Lock (judge/chat 排他制御)
  TTS競合 (warn のみ割り込み可)
  Mode切替 (会話中は定期発話抑制)
```

---

## 観測性

### OpenTelemetry

| Instrument | 内容 |
|-----------|------|
| `pipeline.run` span | パイプライン全体 (type, step, total_ms, escalated) |
| `pipeline.stage1` span | Stage 1 (latency_ms, judgment, confidence, tools) |
| `pipeline.stage2` span | Stage 2 (latency_ms, escalation_reason, tools) |
| `pipeline.calls` counter | 呼び出し数 (type, judgment) |
| `pipeline.escalations` counter | エスカレーション数 |
| `pipeline.latency_ms` histogram | レイテンシ分布 |
| `pipeline.errors` counter | エラー数 |
| `pipeline.timeouts` counter | タイムアウト数 |

### GET /metrics

```json
{
  "total_calls": 45,
  "total_stage2_calls": 3,
  "periodic": {
    "count": 42, "escalation_rate": 0.048,
    "latency_p50": 850, "latency_p95": 1200,
    "judgments": {"continue": 35, "next": 5, "anomaly": 2}
  },
  "user_action": {
    "count": 3, "escalation_rate": 0.333,
    "latency_p50": 2100
  }
}
```

### LangSmith

環境変数3行で自動トレース (コード変更なし):
```
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=lsv2_pt_xxx
LANGCHAIN_PROJECT=guidey
```

---

## プロンプト管理

バージョン付きmdファイルで一元管理。

```
src/domain/guide/prompts/
  periodic_stage1/v1.md     ← 定期判定 (Proactive)
  user_action_stage1/v1.md  ← ユーザー対話
  stage2_escalation/v1.md   ← 共通 Stage2
  plan_generation/v1.md     ← プラン自動生成
  calibration/v1.md         ← キャリブレーション
  analyze_oneshot/v1.md     ← 1ショット解析
```

```python
from src.domain.guide.prompt_loader import Prompt, render
render(Prompt.PERIODIC_STAGE1, step_number="3", ...)
```

バージョン切り替えは `PROMPT_VERSIONS` 定数のみ。

---

## Mobile: 結果表示ルール

| 判定 | 指示カード | ブロックカード | TTS |
|------|-----------|--------------|-----|
| continue (message空) | 変更なし | 変更なし | なし |
| continue (messageあり) | 変更なし | TextBlock (Proactive) | advise |
| next | ステップ更新 | blocks表示 | transition |
| anomaly | **変更なし** | AlertBlock | warn (割り込み) |
| chat応答 | 変更なし | 応答表示 | respond |
| stuck (10回continue) | 変更なし | AlertBlock (info) | advise |

**指示カードは「今やるべきこと」を常に保持。** anomaly やチャットで上書きしない。

---

## ファイル構成

```
backend/src/
├── common/
│   ├── telemetry.py           # OpenTelemetry 初期化
│   └── metrics.py             # OTel instruments + /metrics集計
├── domain/guide/
│   ├── model.py               # ドメインモデル + 安全ルール + 出力サニタイズ
│   ├── service.py             # プロンプト構築 (Prompt定数経由)
│   ├── prompt_loader.py       # md読み込み + バージョン管理
│   └── prompts/               # バージョン付きmdファイル
├── application/guide/
│   ├── blocks.py              # UIブロック型
│   ├── judge_use_case.py      # /judge (LangGraph経由)
│   ├── chat_use_case.py       # /chat (Pipeline直接)
│   └── schemas.py             # JudgeResponse, ChatResponse
├── infrastructure/
│   ├── session/
│   │   ├── store.py           # ValkeySessionStore (create/get/save/delete)
│   │   └── models.py          # Session dataclass
│   ├── agent/
│   │   ├── pipeline.py        # 統一2段階パイプライン (ハーネス内蔵)
│   │   ├── graph.py           # LangGraph (observe→think→safety→act)
│   │   └── tools.py           # LangChain @tool (timer, alert, rag, modify_step)

mobile/
├── hooks/
│   ├── useAutonomousLoop.ts   # 自律ループ (session_id で通信)
│   ├── useAgentState.ts       # Lock + TTS競合管理
│   ├── useSpeechRecognition.ts
│   └── useJudgeApi.ts         # callJudge(session_id + image), callChat(session_id + msg)
├── components/
│   ├── BlockRenderer.tsx      # ブロック描画
│   └── blocks/                # Text, Image, Video, Timer, Alert
└── types/
    ├── blocks.ts
    └── plan.ts
```
