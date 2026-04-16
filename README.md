# Guidey

**ハンズフリーAI作業ガイド** — カメラ越しに作業を見守り、音声で自律的にナビゲーションするエージェント。

料理やDIYの作業中、スマホを手に持たなくても、AIがカメラで状況を判断し、「次はこうして」「火が強すぎます」と声で教えてくれる。

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Mobile** | React Native / Expo / TypeScript / Tamagui |
| **Backend** | FastAPI / Python 3.12 / DDD |
| **LLM** | Gemma 4 (Ollama, ローカル) / Claude Sonnet (API, エスカレーション) |
| **Agent** | LangGraph State Machine / 統一2段階パイプライン |
| **RAG** | Milvus Lite + BM25 ハイブリッド検索 / YouTube自動取り込み |
| **Session** | Valkey (Redis互換) / TTL 30分自動揮発 |
| **Observability** | OpenTelemetry (Traces + Metrics) / LangSmith |
| **Voice** | expo-speech-recognition (STT) / expo-speech (TTS) |

---

## 自律エージェント

ユーザーが何も操作しなくても、AIが自律的に判断して声をかける。

```
Camera (3秒間隔, 適応的)
  ↓
┌──────────────────────────────────────────┐
│  統一2段階パイプライン                       │
│                                          │
│  Stage 1: Gemma (fast, ~1s)              │
│    ├─ 定期判定: continue / next / anomaly │
│    └─ ユーザー対話: 即応答 + ツール実行     │
│           ↓                              │
│  can_handle?                             │
│    ├─ Yes (95%) → 結果を返す              │
│    └─ No  (5%)  → Stage 2へ              │
│                                          │
│  Stage 2: HQ / Claude (deep, ~3-5s)     │
│    RAG検索 + ツール実行 + プラン修正       │
└──────────────────────────────────────────┘
  ↓
Safety Check → Act → TTS読み上げ
```

**定期判定** (periodic) と**ユーザー対話** (user_action) が同じパイプラインを共有。入口だけ違う。

### ハーネス (安全装置)

LLMを信頼しすぎない。7層の安全装置で暴走を防ぐ。

| Layer | 機能 |
|-------|------|
| 入力ガード | 画像10MB制限、形式チェック、768pxリサイズ |
| コスト上限 | Stage2 呼び出し上限 / セッション |
| タイムアウト | periodic 10s / user_action 20s |
| 出力サニタイズ | メッセージ長制限、injection対策、URL検証 |
| 安全チェック | 危険キーワード検知、低確信度ブロック、最低滞在時間ガード |
| Mobile | 適応的サンプリング (3s→10s→20s)、Stuck検知、TTS競合管理 |

**設計原則: 安全なデフォルト** — タイムアウト/コスト超過/低確信度のどの場合も `continue` (現状維持) を返す。

### プロンプト管理

バージョン付きmdファイルで一元管理。コード変更なしでプロンプトを改善できる。

```
src/domain/guide/prompts/
  periodic_stage1/v1.md     ← 定期判定
  user_action_stage1/v1.md  ← ユーザー対話
  stage2_escalation/v1.md   ← エスカレーション
  plan_generation/v1.md     ← プラン自動生成
  ...
```

---

## アーキテクチャ

```
┌─ Mobile (Expo) ─────────────────────────────────────┐
│  CameraView → useAutonomousLoop (3s adaptive)       │
│  useSpeechRecognition (14 VoiceIntents)             │
│  useAgentState (Lock + TTS競合管理)                  │
│  session_id + image/message だけ送信                 │
└──────────────────────┬──────────────────────────────┘
                       │ REST API (session_id ベース)
┌─ Backend (FastAPI) ──┴──────────────────────────────┐
│  routes/guide_router.py                             │
│    /plan/* → session 作成 + session_id 返却          │
│    /judge  → session からコンテキスト取得 → Pipeline   │
│    /chat   → session から履歴取得 → Pipeline          │
│                                                     │
│  infrastructure/                                    │
│    session/store.py  ← Valkey セッション管理          │
│    agent/pipeline.py ← 統一2段階パイプライン           │
│    agent/graph.py    ← LangGraph State Machine       │
│    agent/tools.py    ← LangChain @tool               │
│                                                     │
│  domain/guide/                                      │
│    model.py     ← ドメインモデル + 安全ルール          │
│    service.py   ← プロンプト構築                      │
│    prompts/     ← バージョン付きmdファイル             │
│                                                     │
│  common/                                            │
│    telemetry.py ← OpenTelemetry                     │
│    metrics.py   ← パイプラインメトリクス               │
└─────────────────────────────────────────────────────┘
```

### ディレクトリ構造

```
guidey/
├── backend/
│   ├── src/
│   │   ├── main.py
│   │   ├── config.py
│   │   ├── common/            # telemetry, metrics, json_utils
│   │   ├── domain/guide/      # モデル, サービス, prompts/
│   │   ├── application/guide/ # UseCase, UIブロック, スキーマ
│   │   ├── infrastructure/
│   │   │   ├── agent/         # pipeline, graph, tools
│   │   │   ├── llm/           # Ollama / Claude クライアント
│   │   │   ├── rag/           # Milvus + BM25 + embeddings
│   │   │   └── repositories/  # SQLite, ファイルシステム
│   │   └── routes/
│   └── scripts/               # ingest_pipeline.py 等
│
├── mobile/
│   ├── app/                   # guide.tsx, goal.tsx, settings.tsx
│   ├── hooks/                 # useAutonomousLoop, useAgentState, useSpeechRecognition
│   ├── components/            # BlockRenderer, blocks/, FeedbackButtons
│   └── types/                 # Plan, Block
│
├── docs/                      # 詳細ドキュメント
└── .env.example
```

---

## セットアップ

```bash
cp .env.example .env

# Ollama
brew install ollama && brew services start ollama
ollama pull gemma4:e2b
ollama pull nomic-embed-text

# Valkey (セッション管理)
brew install valkey && brew services start valkey

# Backend
cd backend && uv sync
uv run uvicorn src.main:app --host 0.0.0.0 --port 8000

# Mobile
cd mobile && npm install
npx expo start
```

Development Build (実機テスト・音声認識) の詳細は [mobile-architecture.md](docs/mobile-architecture.md) を参照。

---

## ドキュメント

| ドキュメント | 内容 |
|------------|------|
| [agent-architecture.md](docs/agent-architecture.md) | 自律エージェント、LangGraph、2段階パイプライン、ハーネス |
| [rag-architecture.md](docs/rag-architecture.md) | RAGパイプライン、YouTube取り込み、ハイブリッド検索 |
| [llm-strategy.md](docs/llm-strategy.md) | モデル使い分け、コスト戦略、プロバイダー切り替え |
| [mobile-architecture.md](docs/mobile-architecture.md) | 画面構成、hooks、音声認識、UIブロック |
| [api-architecture.md](docs/api-architecture.md) | Backend アーキテクチャ、レイヤー構成、リクエストフロー |
| [future-design.md](docs/future-design.md) | 未実装の将来設計 |
