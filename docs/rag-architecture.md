# RAG アーキテクチャ詳細

Guidey の RAG (Retrieval-Augmented Generation) パイプラインの設計と実装の詳細。

---

## 全体像

```
┌─────────────────────────────────────────────────────────┐
│  データ登録 (Offline)                                     │
│                                                         │
│  YouTube動画 → yt-dlp → 字幕 + 動画                      │
│       ↓                                                 │
│  Gemma 4: 意味的セグメンテーション (5-15ステップ)            │
│       ↓                                                 │
│  ffmpeg: 3フレーム/ステップ (開始/中間/完了)                 │
│       ↓                                                 │
│  Gemma 4: visual_marker改善 + 詳細キャプション生成          │
│       ↓                                                 │
│  Gemma 4: 品質スコアリング (0.3未満破棄)                    │
│       ↓                                                 │
│  nomic-embed-text: テキスト埋め込み + キャプション埋め込み    │
│       ↓                                                 │
│  ┌─────────────┐  ┌──────────────┐                      │
│  │ Milvus Lite │  │ BM25 Index   │                      │
│  │ (SQLite)    │  │ (In-memory)  │                      │
│  └─────────────┘  └──────────────┘                      │
└─────────────────────────────────────────────────────────┘
                        ↕
┌─────────────────────────────────────────────────────────┐
│  検索 (Online)                                           │
│                                                         │
│  クエリ (テキスト or 画像キャプション)                       │
│       ↓                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Dense    │  │ Caption  │  │ BM25     │              │
│  │ (text)   │  │ (visual) │  │ (sparse) │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
│       └──────────────┼──────────────┘                   │
│                      ↓                                  │
│              RRF (Reciprocal Rank Fusion)                │
│                      ↓                                  │
│              検索結果 (RagResult[])                       │
└─────────────────────────────────────────────────────────┘
```

---

## データ層構造 (3層)

### Layer 1: Source (生データ)
```
backend/static/
├── manual/           # 手動JSON (テスト用)
│   └── mac-setup/
│       ├── steps.json
│       └── frames/
└── videos/           # YouTube動画から自動生成 (.gitignore対象)
    └── {video_id}/
        └── frames/
            ├── step_01_start.jpg
            ├── step_01_mid.jpg
            ├── step_01_end.jpg
            └── ...
```

### Layer 2: Chunk (検索単位)
1ステップ = 1チャンク。各チャンクは以下を持つ:
- テキスト説明 (`text`)
- 視覚的完了基準 (`visual_marker`)
- 3枚のフレーム画像 (開始/中間/完了)
- Gemma生成の詳細キャプション (`frame_caption`)
- 品質スコア (`quality_score`)

### Layer 3: Vector (検索インデックス)
各チャンクに2つのベクトルを保持:
- `embedding`: テキスト説明の埋め込み (nomic-embed-text, 768次元)
- `caption_embedding`: フレームキャプションの埋め込み (nomic-embed-text, 768次元)

---

## Milvus スキーマ

DB: `backend/db/guidey.db` (Milvus Lite, SQLiteベース)

コレクション: `diy`, `cooking` (モード別)

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | INT64 (PK, auto) | 自動採番ID |
| `video_id` | VARCHAR(64) | 元動画のYouTube ID |
| `step_number` | INT16 | ステップ番号 |
| `total_steps` | INT16 | 全ステップ数 |
| `text` | VARCHAR(2048) | ステップの説明テキスト |
| `frame_path` | VARCHAR(256) | 代表フレームのパス |
| `embedding` | FLOAT_VECTOR(768) | テキスト埋め込み |
| `visual_marker` | VARCHAR(512) | カメラで確認できる完了基準 |
| `frame_start_path` | VARCHAR(256) | 開始フレームのパス |
| `frame_mid_path` | VARCHAR(256) | 中間フレームのパス |
| `frame_end_path` | VARCHAR(256) | 完了フレームのパス |
| `quality_score` | FLOAT | 品質スコア (0.0-1.0) |
| `duration_sec` | FLOAT | ステップの所要時間 |
| `frame_caption` | VARCHAR(2048) | Gemma生成の詳細キャプション |
| `caption_embedding` | FLOAT_VECTOR(768) | キャプション埋め込み |

インデックス: FLAT (COSINE) を `embedding` と `caption_embedding` 両方に設定。

---

## データ登録パイプライン

### ingest_pipeline.py (統合パイプライン)

3つのモードに対応:

```bash
cd backend
# YouTube自動検索 → 上位N件をインジェスト
uv run python -m scripts.ingest_pipeline search "Mac 初期設定" --mode diy --count 5

# JSONバッチ
uv run python -m scripts.ingest_pipeline batch sources.json

# 単一URL
uv run python -m scripts.ingest_pipeline url "https://youtube.com/watch?v=XXXX" --mode diy
```

#### 12ステップのパイプライン

| Step | 処理 | ツール | 出力 |
|------|------|--------|------|
| 1 | YouTube検索 (自動モード) or 字幕DL | yt-dlp | 候補動画 or VTT |
| 2 | 動画ダウンロード (永続保存) | yt-dlp | MP4 → static/videos/{id}/source/ |
| 3 | VTTパース + 5分チャンク分割 | Python | タイムスタンプ付きセグメント |
| 4 | 2段階ステップ分解 (チャンク別→統合) | Gemma 4 (LLM) | 5-10ステップ + visual_marker |
| 5 | テキスト整理 (口語→指示形) | Gemma 4 (LLM) | 整理されたステップテキスト |
| 6 | 候補フレーム抽出 (8枚/ステップ) | ffmpeg | 候補フレーム画像 |
| 7 | LLMベストフレーム選択 | Gemma 4 (VLM) | best + completion フレーム |
| 8 | visual_marker改善 + キャプション生成 | Gemma 4 (VLM) | 改善されたmarker + 詳細キャプション |
| 9 | 品質スコアリング | Gemma 4 (LLM) | 0.0-1.0スコア、0.3未満破棄 |
| 10 | 埋め込み生成 (テキスト + キャプション) | nomic-embed-text | dual embedding |
| 11 | Milvus格納 | pymilvus | コレクションに挿入 |
| 12 | BM25インデックス構築 + テスト検索 | rank-bm25 | 検証 |

#### チャンキング戦略
- **意味的セグメンテーション**: LLMが字幕から作業の区切りを判定
- 時間均等分割ではなく、「1つの作業 = 1チャンク」の原則
- 各チャンクに `visual_marker` (視覚的完了基準) を付与

#### 品質ゲート
LLMが以下の基準でスコアリング:
- **具体性**: 「何をするか」が明確か
- **視覚判定可能性**: visual_marker がカメラで確認できるか
- **粒度の適切さ**: 1〜5分で完了する粒度か
- 0.3未満のステップは自動破棄

#### キャプション生成 (Caption-based Multimodal RAG)
各ステップの代表フレームを Gemma 4 (VLM) に見せて、以下の観点で詳細記述:
1. **場面**: 何が映っているか (道具、材料、画面)
2. **状態**: 材料や作業対象の現在の状態 (色、形、配置)
3. **動作**: 行われている/完了した作業
4. **道具**: 使用されている道具や機材

このキャプションを埋め込むことで、画像モデル (CLIP等) なしでマルチモーダル検索が可能。

### 手動テストデータ

`static/manual/{source_id}/steps.json` に手動JSON形式でテストデータを配置可能。
`GET /guide/plan/{source_id}` で読み込み。

---

## 検索方式

### 1. Dense検索 (テキスト)
- フィールド: `embedding`
- モデル: nomic-embed-text (768次元, Ollama経由)
- ユースケース: ゴールテキストから類似ステップを検索

### 2. Dense検索 (キャプション)
- フィールド: `caption_embedding`
- モデル: nomic-embed-text (768次元)
- ユースケース: 画像の内容に基づく検索 (Caption-based Multimodal)

### 3. BM25検索 (スパース)
- トークナイザ: 日本語bi-gram (形態素解析なし、軽量)
- ユースケース: 「塩 小さじ1」のようなキーワード検索

### 4. ハイブリッド検索 (Dense + BM25)
- RRF (Reciprocal Rank Fusion, k=60) で統合
- 各方式から top_k×2 件取得 → RRFでスコア統合 → top_k件返却
- BM25インデックスが空の場合はDenseのみにフォールバック

```python
# 検索フロー
query_embedding = embed(goal)
dense_results = milvus.search(embedding=query_embedding)
bm25_results = bm25.search(query_text=goal)
fused = reciprocal_rank_fusion([dense_results, bm25_results])
```

---

## アプリでの利用箇所

### プラン自動生成 (`plan_use_case.py`)
1. ゴール入力 → RAG検索 (テキスト Dense) → 関連ステップをコンテキストに含める
2. LLM (Gemma 4) がステップリストを生成
3. 各ステップのテキストで再度RAG検索 → お手本画像 (frame_url) を事前キャッシュ
4. メモリキャッシュで同一ゴールの再生成を回避

### 手動解析 (`use_case.py`)
1. カメラ画像 + ゴール → RAG検索 (ハイブリッド) → 参考ステップを取得
2. LLMに画像 + 参考ステップを渡して指示生成
3. SSEストリーミングでモバイルに返却

### 自律判定 (`judge_use_case.py`)
- RAGは直接使わず、プラン (ステップリスト) をもとに判定
- LangGraph State Machine で observe → think (pipeline) → safety_check → act

---

## 埋め込みモデル

| モデル | 用途 | 次元 | 提供 |
|--------|------|------|------|
| nomic-embed-text | テキスト + キャプション埋め込み | 768 | Ollama (ローカル) |

### 将来の拡張
| Phase | モデル | 用途 |
|-------|--------|------|
| 現在 | nomic-embed-text + Gemmaキャプション | テキストベースのマルチモーダル |
| 次 | ColSmolVLM | 画像直接埋め込み (Late Interaction) |
| 最終 | ColPali | 最高精度の画像埋め込み |

---

## ファイル構成

```
backend/
├── scripts/
│   ├── ingest_pipeline.py     # 統合パイプライン (search/batch/url)
│   └── feedback_batch.py      # 週次フィードバック→RAGスコア反映
├── src/infrastructure/
│   ├── rag/
│   │   ├── milvus.py          # Milvus Liteクライアント (スキーマ + CRUD + 検索)
│   │   ├── embeddings.py      # nomic-embed-text ラッパー
│   │   ├── bm25.py            # BM25インメモリインデックス
│   │   └── hybrid.py          # ハイブリッド検索 (Dense + BM25 → RRF)
│   └── repositories/
│       └── plan_repository.py # ファイルシステムからプラン読み込み
├── src/domain/guide/
│   └── model.py               # RagResult, PlanStep 等のドメインモデル
└── db/                        # .gitignore 対象
    ├── guidey.db              # Milvus Lite DB
    └── guidey_user.db         # パーソナライズ用SQLite
```

---

## 設定

`backend/.env` で設定可能:

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `MILVUS_DB_PATH` | `./db/guidey.db` | Milvus Lite DBのパス |
| `EMBEDDING_MODEL` | `nomic-embed-text` | 埋め込みモデル名 |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama APIのURL |
| `OLLAMA_MODEL` | `gemma4:e2b` | LLM/VLMモデル名 |

---

## 事前準備

```bash
# システム依存
brew install yt-dlp ffmpeg

# Ollamaモデル
ollama pull gemma4:e2b
ollama pull nomic-embed-text

# データ登録 (単一URL)
cd backend
uv run python -m scripts.ingest_pipeline url "https://youtube.com/watch?v=XXXX" --mode diy

# データ登録 (YouTube検索で自動収集)
uv run python -m scripts.ingest_pipeline search "Mac 設定" --mode diy --count 3
```
