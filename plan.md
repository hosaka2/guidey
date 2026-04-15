# Guidey 開発ロードマップ

## Vision
「透明なアシスタント」— ユーザーが何も言わなくても、AIがカメラ越しに作業を見守り、適切なタイミングで次のステップを音声で指示する自律エージェント。

---

## アーキテクチャ全体像

```
┌─ Mobile (Expo / iPhone) ─ 「感覚器」──────────────┐
│  expo-camera        → 自動キャプチャ (5-10秒/枚)   │
│  expo-speech        → TTS 日本語読み上げ           │
│  expo-speech-recognition → 音声トリガー            │
│  Tamagui            → グラスモフィズムUI            │
└──────────────────────────────────────────────────┘
                     │ REST API (ngrok)
┌─ Harness Layer (FastAPI + LangGraph) ─「神経系」──┐
│                                                  │
│  ┌─ Decision Engine ───────────────────────────┐ │
│  │  Observe → Appraise → Think → Act → Wait   │ │
│  └─────────────────────────────────────────────┘ │
│                                                  │
│  ┌─ Context Manager ──────────────────────────┐  │
│  │  3-Tier Memory (短期/中期/長期)              │  │
│  │  ツールコントラクト (Pydantic スキーマ)       │  │
│  │  フラストレーション検出                       │  │
│  └─────────────────────────────────────────────┘ │
│                                                  │
│  ┌─ Tool Executor ────────────────────────────┐  │
│  │  タイマー設定 / YouTube検索 / RAG検索        │  │
│  └─────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
                     │
┌─ Brain & Knowledge ─「脳」────────────────────────┐
│  Gemma 4 12B (Ollama)  → メイン推論 (コスト0)      │
│  Claude Sonnet (API)   → 高難度判断 (オプション)    │
│  Milvus Lite + ColPali → Multimodal RAG           │
│  YouTube字幕           → 手順チェックリスト         │
└──────────────────────────────────────────────────┘
```

## 黄金ルール
- **モデルを信じすぎない**: 判断の最終「許可」はハーネス層のルール(安全確認)が握る
- **キャッシュを使い倒す**: 変わらないレシピ情報はプロンプト上部に固定、レスポンス1秒以下を保つ
- **スマホは感覚器に徹する**: 重い処理は一切しない

---

# 実装フェーズ

## Step 1: MVP ✅
画像1枚 + ボタン操作で「対話」を成立させる。

### 構成
- Mobile: Expo Go (iPhone実機) + Tamagui UI
- Backend: FastAPI + LangChain + Gemma 4 (Ollama) / Claude切替対応
- 通信: ローカルIP (同一WiFi)

### タスク
- [x] プロジェクト構造 (backend DDD + mobile Expo tabs)
- [x] カメラ撮影 → API送信 → TTS読み上げの一本道実装
- [x] Settings画面 (API URL設定 + 接続テスト + AsyncStorage永続化)
- [x] Tamagui UI リデザイン (メイン画面/撮影画面/Settings)
- [x] Ollama + Gemma 4 セットアップ
- [x] LLM切替え対応 (ollama/anthropic, LLMClient Protocol + BaseLangChainClient)
- [x] iPhone実機で E2E疎通 (ローカルIP)

---

## Step 2: ストリーミング + RAG + オーバーレイUI ✅
SSEストリーミング + RAGパイプライン + カメラ映像上にアシスト情報を表示。

### 実装済み
- **SSEストリーミング**: XHR + readyState >= 3 でプログレッシブ受信、JSON文字列エンコードで改行保持
- **文単位TTS**: 。！？\n 区切りで逐次読み上げ、マークダウン記号除去
- **ゴール入力画面**: モード選択 → ゴール入力 → カメラの3ステップ
- **RAGパイプライン**: nomic-embed-text + Milvus Lite、手動JSON/YouTube動画両対応
- **SSEメタイベント**: RAG結果(お手本画像URL, 全ステップ一覧, 現在推定ステップ)をストリーム先頭で送信
- **オーバーレイUI**: お手本画像(ピンチ拡大縮小)、ステップ一覧(タップ展開/折りたたみ)
- **指示カード**: Markdownレンダリング、高さ制限+スクロール、折りたたみ可能

### タスク
- [x] SSEストリーミングレスポンス (Backend + Mobile XHR)
- [x] 文単位TTS + マークダウン除去
- [x] ゴール入力画面 (goal.tsx)
- [x] 共有モード定義 (constants/modes.ts)
- [x] BaseLangChainClient 抽出 (LLMクライアント共通化)
- [x] nomic-embed-text + Milvus Lite RAGインフラ
- [x] ingest_manual.py (手動JSONインジェスト) + Mac設定テストデータ
- [x] ingest_video.py (YouTube動画インジェスト)
- [x] UseCase RAG統合 + graceful degradation
- [x] SSEメタイベント (全ステップ一覧含む)
- [x] お手本画像オーバーレイ (ピンチ拡大縮小)
- [x] ステップ一覧表示 (現在ステップハイライト)
- [x] 指示カード Markdownレンダリング + 折りたたみ

### Step 2.5: 音声トリガー ✅
- [x] `expo-speech-recognition` で音声トリガー (Development Build)
- [x] 「教えて」→ キャプチャ、「ストップ」→ TTS停止
- [x] TTS再生中はマイク一時停止 → 終了後に自動再開
- [x] iOS 18 無音タイムアウト対策 (auto-restart)
- [x] no-speech/aborted エラーのログ抑制
- [ ] Settings に「ゴーグルモード」トグル

---

## Step 3: 自律エージェント化 (事前計画 + 自動キャプチャ + LangGraph)
ユーザーが何も言わなくても、AIが作業を見守り自律的に指示する。

### 核心設計: 事前計画方式
ユーザーがゴール入力時にRAGからステップリストを事前生成。
実行時は「今のステップが継続中か / 次に進んだか」の3択判定のみ。

```
[セッション開始]
1. ユーザーが作業内容を入力 (「肉じゃがを作りたい」)
2. RAGからステップリストを事前生成 (5〜8ステップ)
   - 各ステップに視覚的判定基準 (visual_marker) を付与
   - 各ステップに対応するお手本画像をRAGからキャッシュ
3. キャリブレーション: カメラで現状確認 → 開始ステップを自動判定

[自律監視ループ (5秒間隔、適応的)]
1. Observe  → スマホが自動で画像を送信
2. Appraise → ピクセル差分で粗く判定。変化なし → 間隔延長して待機
3. Think    → 変化あり → LLMが3択判定 (継続 / 次工程 / 異常)
4. Act      → 次工程: お手本画像更新 + 音声指示 / 異常: 確認 / 継続: 何もしない
5. Wait     → 適応的サンプリングで次のキャプチャまで待機
```

### 事前計画のメリット
| 項目 | 推測方式 | 事前計画方式 |
|------|---------|-------------|
| 工程特定精度 | 60-75% | 85-95% |
| お手本表示速度 | 数秒 | 即座 (キャッシュ済み) |
| LLM呼び出しコスト | 高 (毎回判定) | 低 (3択判定) |
| 設計の複雑さ | 高 | 低 |

### Step スキーマ (事前生成)
```python
class PlanStep(BaseModel):
    name: str                    # "玉ねぎを切る"
    expected_duration_min: int   # 想定時間
    visual_marker: str           # "みじん切りされた玉ねぎが見える"
    reference_image_url: str     # 事前キャッシュしたお手本
    instructions: str            # 音声指示用テキスト
```

### 進捗管理の安定化戦略
1. **ヒステリシス**: 工程変更には2〜3回連続で同じ判定が必要 (1回のブレで切り替えない)
2. **適応的サンプリング**: 変化なし連続で間隔を5秒→15秒→30秒に延長
3. **State更新はハーネス側で制御**: LLMには「変化があったか」だけ答えさせる
4. **Confidence < 閾値なら黙る or 確認**: 低確信度時は音声で確認する

### 判定プロンプト (状態固定方式)
```
現在のステップ: {step_name} (開始から{elapsed}分経過)
次のステップ: {next_step_name}
直近の観察: {recent_observations}

新しい画像を見て答えて:
A) この工程を継続中
B) 次の工程に進んだ (何の工程?)
C) 想定外の状態 (詳細?)

確信度 (0.0-1.0):
```

### State スキーマ
```python
class GuideState(TypedDict):
    mode: str                    # "diy" | "cooking"
    
    # 事前生成
    plan: list[PlanStep]         # RAGで作ったステップリスト
    current_step_index: int      # 今どこ
    
    # 実行時
    current_step_status: str     # "in_progress" | "near_completion" | "completed"
    current_step_started_at: datetime
    confidence: float            # 0.0-1.0
    
    # 状態安定化
    last_3_judgments: list[str]  # ヒステリシス用
    no_change_count: int         # 適応的サンプリング用
    
    # 完了履歴 (要約のみ、コンテキスト膨張防止)
    completed_steps: list[dict]  # [{name, duration, notes}]
    
    # 短期メモリ
    recent_images: list[bytes]   # 直近3〜5枚
    recent_observations: list[str]  # 直近の観察結果 (圧縮)
    
    # フィードバック
    user_corrections: list[str]  # ユーザーからの修正履歴
    frustration_level: float     # 0-1
    
    # 音声ループ協調
    is_paused: bool              # ユーザーが「待って」と言った / プラン修正中
    is_user_speaking: bool       # 音声認識中 (TTS発話を抑制)
    is_agent_speaking: bool      # TTS発話中
    pending_user_query: str      # ユーザーの質問 (即キャプチャ→回答)
    user_reports: list[dict]     # ユーザーの状況報告 [{text, timestamp}]
```

### アーキテクチャ: 2ループ並行 + 共有State
画像監視と音声入力は独立して動き、SharedState を介して協調する。

```
┌─ Loop A: 画像監視ループ (5秒間隔、適応的) ────────┐
│  Observe → Appraise → Think → Act → Wait       │
└──────────────────────────────────────────────────┘
                    ⇅ SharedState
┌─ Loop B: 音声入力ループ (常時リッスン) ────────────┐
│  Listen → Transcribe → Intent分類 → Apply       │
└──────────────────────────────────────────────────┘
```

### 音声Intent分類 (14種類)
| Intent | 例 | アクション | 処理速度 |
|--------|---|----------|---------|
| next_step | 「次」「できた」 | step += 1 | キーワード即応 |
| previous_step | 「戻して」 | step -= 1 | キーワード即応 |
| skip_step | 「スキップ」 | step += 1, mark skipped | キーワード即応 |
| pause | 「ちょっと待って」 | 監視ループ停止 | キーワード即応 |
| resume | 「再開」「続き」 | 監視ループ再開 | キーワード即応 |
| repeat | 「もう一回言って」 | 直前の指示を再生 | キーワード即応 |
| question | 「これでいい?」 | 即キャプチャ→分析→回答 | Gemma 4 (~1秒) |
| report_status | 「玉ねぎ切った」 | State更新→強制再評価 | Gemma 4 (~1秒) |
| request_help | 「分からない」 | 詳細説明+お手本表示 | Gemma 4 (~1秒) |
| modify_plan | 「醤油切らした」 | プラン再生成 | Claude (~5秒) |
| change_task | 「カレーに変更」 | 新規セッション | Claude (~5秒) |
| feedback | 「役立った」 | フィードバック記録 | ルールベース |
| tool_request | 「タイマー5分」 | ツール実行 | ルールベース |
| unknown | (不明な発話) | 無視 or 確認 | - |

### 処理階層 (3段)
1. **キーワードマッチ** (next, pause, repeat等) → 0.1秒応答、LLM不要
2. **ローカルLLM** (question, report_status等) → ~1秒応答、Gemma 4
3. **高品質モデル** (modify_plan, change_task) → ~5秒応答、Claude Sonnet

### 衝突回避ルール
- `is_user_speaking` / `is_agent_speaking` フラグで発話衝突防止
- プラン修正中 (`is_paused`) は監視ループを一時停止
- **ユーザー報告は画像判定より優先** (ユーザーを信頼するエージェント)
- 質問Intentは即座にキャプチャをトリガー (定期タイマーを待たない)
- TTS再生中にユーザーが喋り始めたら即停止 (割り込みOK)

### 重要操作の復唱確認
タスク変更、プラン全体変更等の破壊的操作は確認を挟む:
```
ユーザー: 「カレーに変更」
エージェント: 「肉じゃがを中止してカレーに変更しますか?」
ユーザー: 「はい」
→ 実行
```

### 段階的実装
- **α**: 基本Intent (next/previous/pause/repeat) のキーワードマッチのみ ← これだけで体験激変
- **β**: report_status, question を追加 → 「会話できる」感
- **γ**: modify_plan を追加 (Claude統合) → 真に柔軟なエージェント
- **δ**: 復唱確認、割り込み対応、Confidence管理 → プロダクション品質

### お手本画像の表示 (アプローチA: RAG事前キャッシュ)
セッション開始時に各ステップに対応するお手本画像をRAGから事前検索してキャッシュ。
ステップが進んだら対応する画像を即座に表示 (リアルタイムRAG検索不要)。

```
事前: 各ステップに対応するお手本画像を事前にRAG検索してキャッシュ
  Step 1: 玉ねぎを切る → 「みじん切りされた玉ねぎ」画像をキャッシュ
  Step 2: 肉を切る → 「適切なサイズの肉」画像をキャッシュ
  ...
実行中: ステップが進んだら即座に対応する画像を表示 (待ち時間ゼロ)
```

### 3-Tier Memory
| 層 | 保持期間 | 内容 | 実装 |
|----|---------|------|------|
| **短期** | 直近5枚 | 画像コンテキスト（差分比較用） | `deque(maxlen=5)` |
| **中期** | セッション中 | 現在のレシピ/手順の進捗状況 (圧縮) | LangGraph checkpoint |
| **長期** | 永続 | ユーザーの過去の失敗傾向、所有工具リスト | Milvus Lite + SQLite |

---

### RAGデータ設計

#### データ層構造 (3層)
```
[Layer 1: Source] 生データ保管 (後でチャンキング戦略変更可能)
  sources/
    videos/        # YouTube動画 (mp4)
    pdfs/          # 取説PDF
    webpages/      # スクレイピングHTML
    user_uploads/  # ユーザーが撮った画像
       ↓ 抽出 (Gemma 4 / Claude)
[Layer 2: Chunk] 検索単位 (1ステップ = 1チャンク)
  VideoChunk: transcript + 代表フレーム(開始/中間/完了の3枚) + visual_marker
  PDFChunk:   ページ画像 + 抽出テキスト + 図表キャプション
  RecipeChunk: テキスト + 材料リスト
       ↓ 埋め込み (用途別モデル)
[Layer 3: Vector] 検索インデックス (1チャンクに複数ベクトル)
  text_embedding (BGE-M3) + image_embedding (ColPali) + BM25 (sparse)
```

#### チャンキング戦略 (精度の8割を決める)
| ソース | チャンク単位 | フレーム抽出 | 方法 |
|-------|-----------|-----------|------|
| YouTube動画 | 1ステップ (意味的セグメンテーション) | 開始/中間/完了の3枚 | Gemma 4で字幕からステップ境界判定 |
| 取説PDF | 1ページ | ページ画像そのまま (ColPali) | OCR不要 |
| レシピサイト | 1ステップ | サムネのみ | 構造化抽出 |

⚠️ 悪いチャンキング: 時間均等分割 (5分ごと) → ステップ境界無視で検索精度崩壊
✅ 良いチャンキング: 意味的セグメンテーション → 1ステップ = 1チャンクで検索が機能

#### 埋め込みモデル使い分け (全部ColPaliは過剰)
| データ種別 | モデル | 理由 |
|----------|--------|------|
| テキスト (字幕、手順) | BGE-M3 (or nomic-embed-text) | 多言語、密ベクトル |
| 画像 (フレーム、ページ) | ColPali | OCR不要、図表対応 |
| キーワード (「塩 小さじ1」等) | BM25 (sparse) | 固有値に強い |

ColPaliが特に効く場面: 取説PDF (図表多い)、料理画像の状態マッチング (焼き色、とろみ)
ColPali不要な場面: 字幕テキスト検索、材料リスト、ステップ名

#### データベース構成
**Milvus Lite** (ベクトル + メタデータ):
```
chunks コレクション:
  chunk_id, source_id, chunk_type, domain
  text_embedding (BGE-M3, dim=1024)
  image_embedding (ColPali, dim=128, 初期は平均ベクトルで簡易導入)
  quality_score, hit_count, last_hit_at, global_feedback_score
  owner_user_id (NULL=共有, あり=個人) ← パーソナライズ拡張用
  visibility ("public" | "private")     ← パーソナライズ拡張用
```

**SQLite** (構造化データ):
```
sources          # 元データのメタ情報
chunks_metadata  # チャンクの詳細 (transcript, visual_marker等)
users            # ユーザー情報
user_preferences # 嗜好 (spice_level, cooking_skill, tools_owned)
user_sessions    # 利用履歴 (plan_json, used_chunk_ids)
feedback         # RAGチャンクへのフィードバック
user_mistakes    # 失敗履歴 ("塩を入れすぎた")
```

⚠️ `owner_user_id`, `visibility` は最初から入れる (今は NULL/'default' で単一ユーザー運用)
→ 将来のパーソナライズ時にマイグレーション地獄を回避

#### マルチモーダル検索 (段階的導入)
```
✅ Step 3a: Dense (nomic-embed-text) のみ
✅ Step 3c: + BM25 ハイブリッド検索
→ 次: + CLIP (画像埋め込み) → マルチモーダルRAG
→ 将来: CLIP → ColSmolVLM に置き換え (精度向上)
→ 将来: + Reranker + パーソナライズ再ランキング
```

検索フロー (最終形):
```
テキストクエリ → Dense検索 (nomic-embed-text)
             → BM25検索 (キーワード)      → RRF統合 → Rerank → パーソナライズ
画像クエリ   → CLIP/ColSmolVLM検索 (画像)
```

#### 画像埋め込みモデルの段階的移行
| Phase | モデル | 方式 | メリット | デメリット |
|-------|-------|------|---------|----------|
| **今** | CLIP (ViT-B-32) | 単一ベクトル (512次元) | 軽量~600MB, Mac確実に動く | 汎用的、ドキュメント特化ではない |
| **将来** | ColSmolVLM | Late Interaction (多ベクトル) | 高精度、ドキュメント検索向け | ~2GB、Milvusの多ベクトル対応が必要 |
| **最終** | ColPali | Late Interaction (多ベクトル) | 最高精度 | 重い、GPU推奨 |

CLIP → ColSmolVLM の差し替えは embedding 関数を変えるだけ (検索ロジックは同じ)。
ColSmolVLMはLate Interaction (ColPaliと同じ方式) の軽量版で、Colab無料枠でも動作する。

#### データ収集パイプライン (実装済み: ingest_video_v2.py)
```
[1. 取得]
  YouTube URL → yt-dlp: 動画 + 字幕ダウンロード

[2. パース]
  VTT → タイムスタンプ付きテキスト → 重複除去

[3. セグメンテーション] (Gemma 4)
  字幕 → 意味的分割 → ステップリスト (name, visual_marker, start/end_sec)

[4. フレーム抽出]
  ステップごと → ffmpegで3フレーム (開始/中間/完了)

[5. visual_marker改善] (Gemma 4 + フレーム画像)
  完了フレームを見て visual_marker を検証・改善

[6. 品質ゲート] (Gemma 4)
  各チャンクをスコアリング (0.0-1.0)、0.3未満は破棄

[7. ベクトル化]
  字幕テキスト → nomic-embed-text → text_embedding
  代表フレーム → CLIP → image_embedding (次ステップで追加)

[8. インデックス]
  Milvus (拡張スキーマ) + BM25 インデックス

[9. 検証]
  テスト検索で品質確認
```

#### パーソナライズ拡張 (今は実装しない、スキーマで対応)
- Phase 1 (今): user_id を全テーブルに入れるだけ
- Phase 2 (将来): 利用履歴ベースの再ランキング
- Phase 3 (将来): ユーザー固有RAG (自分のレシピ本をインデックス)
- Phase 4 (将来): 嗜好自動学習 (よく作るジャンル、苦手な作業、失敗傾向)

---

### 実装サブステップ

#### Step 3a: 自動キャプチャ + 3択判定ループ ✅
- [x] 自動キャプチャタイマー (適応的間隔 5s→15s→30s)
- [x] 3択判定プロンプト (状態固定方式)
- [x] ヒステリシス (2回連続で状態遷移)
- [x] 適応的サンプリング
- [x] 手動JSONプランで動作確認

#### Step 3b: RAGからの自動ステップ生成 + お手本画像 ✅
- [x] ステップ生成プロンプト (visual_marker付き)
- [x] ゴール入力 → RAG検索 → ステップリスト自動生成
- [x] 生成結果をユーザーが確認・編集できるUI (プラン確認画面)
- [x] キャリブレーション (is_calibration パラメータ)
- [x] お手本画像事前キャッシュ (テキスト埋め込み + Gemmaキャプション)
- [x] Multi-Document Synthesis (複数ソース統合で最適プラン生成)

#### Step 3c: LangGraph統合 + ハイブリッド検索 ✅
- [x] LangGraph State Machine (Observe→Appraise→Think→Safety→Act)
- [x] 3-Tier Memory (短期/中期/長期をState内蔵)
- [x] ハーネス層 (危険キーワード検出 + 低確信度ブロック)
- [x] BM25 ハイブリッド検索 (Dense + BM25 → RRF統合)
- [x] SQLiteパーソナライズスキーマ (users, preferences, sessions, feedback, mistakes)
- [x] 意味的変化検知 (Appraise: キャプション embedding コサイン類似度)
- [x] 音声Intent拡張 (12種: next/previous/skip/pause/resume/repeat/question/report/help等)

#### RAGパイプライン ✅
- [x] ingest_pipeline.py: YouTube自動検索 + JSONバッチ + 単一URL
- [x] 2段階ステップ分解 (チャンク別分割→統合・精緻化)
- [x] テキスト整理 (口語→指示形)
- [x] 8候補フレーム→LLMベスト選択
- [x] Gemma詳細キャプション + caption_embedding (マルチモーダルRAG)
- [x] 品質ゲート (0.3未満破棄)
- [x] 動画永続保存 (static/videos/{id}/source/)

---

### 将来の設計方針 (未実装)

#### LLM処理の2段階設計
全ての判断・応答を「Gemma 1段目 + Claude 2段目」の階層で処理。
Gemmaが自己判断で「Claudeに任せるべき」と判定したら自動エスカレーション。

- **1段目 Gemma** (1秒, ¥0): 即応答、簡単なAction、状態判定、質問への即答
- **2段目 Claude** (3秒, API): プラン修正、複雑な提案、重要判断
- Gemmaのプロンプトに「エスカレーション基準」を記載
- つなぎ発話: Claude呼び出し前に「少し考えますね」で待ち時間吸収

#### Tool Calling (Claude 2段目)
- Gemma 1段目: tool callingなし (シンプル維持)
- Claude 2段目: tool callingフル活用
- ツール: search_rag, modify_plan, set_timer, capture_image, ask_user, speak等
- Pydanticスキーマでツール定義、呼び出し上限で暴走防止

#### UIブロック設計 (Generative UI)
LLM応答を構造化ブロックのリストとして表現:
- TextBlock, ImageBlock, VideoBlock, TimerBlock, NutritionBlock, ChoiceBlock等
- Pydantic Discriminated Union で型安全
- 画面: 常時表示エリア + 動的カードエリア (最大3枚)
- 双方向通信: UserAction でフロント→バック

#### フィードバック設計 (明示のみ)
暗黙的行動分析は行わない (プライバシー配慮 + 実装複雑化回避)。
- **音声検出** (Gemma 1段目): negative/plan_retry/positive
- **UIタップ**: 発話後👍👎 / ステップ完了3択 / セッション終了まとめ
- 週次バッチでRAGスコア更新
- plan_retry: 失敗プランのソースをMulti-Document Synthesisで除外

#### マルチモーダル検索の段階的移行
| Phase | モデル | 方式 |
|-------|-------|------|
| 現在 | nomic-embed-text + Gemmaキャプション | Caption-based Multimodal |
| 次 | ColSmolVLM | Late Interaction (軽量) |
| 最終 | ColPali | Late Interaction (最高精度) |

---

## モデル使い分け戦略

### 3層構成 (実装済み)
| 用途 | モデル | 設定 | 速度 |
|------|--------|------|------|
| **高速** (リアルタイム判定、ストリーミング) | gemma4:e2b | think=False, 4K ctx | ~2秒 |
| **高品質** (RAG作成、プラン生成) | gemma4:26b | think=True, 32K ctx | ~10秒 |
| **最高品質** (将来: エスカレーション先) | Claude Sonnet | API | ~3秒 |

### 判断基準
| 条件 | Claude | Gemma HQ (26b) | Gemma Fast (e2b) |
|------|--------|----------------|------------------|
| 頻度 | 数回/セッション | 数十回/セッション | 数百回/セッション |
| 精度重要 | ✅ | ✅ | |
| 速度重要 | | | ✅ |
| プライバシー | | ✅ | ✅ |
| コスト | API課金 | ¥0 | ¥0 |

### コスト試算
| 用途 | モデル | 月コスト |
|------|--------|---------|
| リアルタイム判定 | Gemma e2b | ¥0 |
| プラン生成 | Gemma 26b (将来: Claude) | ¥0 (将来: ~¥100) |
| RAGパイプライン | Gemma 26b | ¥0 |
| エスカレーション (将来) | Claude | ~¥500 |

### キャッシュ戦略
同じレシピを再度作る場合、前回のステップを再利用 (Claude呼び出し不要)。

### フォールバック
Claude API不調時は Gemma 4 でステップ生成にフォールバック (品質は落ちるが動作は継続)。

---

## 技術スタック

| レイヤー | 技術 | 状態 |
|---------|------|------|
| Mobile | Expo, Tamagui, expo-camera, expo-speech | 実装済み |
| Markdown | react-native-markdown-display | 実装済み |
| ジェスチャー | react-native-gesture-handler + reanimated | 実装済み |
| 音声認識 | expo-speech-recognition | 実装済み |
| Backend | FastAPI, LangChain, SSEストリーミング | 実装済み |
| LLM (メイン) | Gemma 4 12B (Ollama, ローカル) | 実装済み |
| LLM (高品質) | Claude Sonnet (API, オプション) | 実装済み |
| Embedding | nomic-embed-text (Ollama) | 実装済み |
| ベクトルDB | Milvus Lite (pymilvus) | 実装済み |
| 自律制御 | LangGraph | Step 3 |
| ビジュアル検索 | ColPali / ColQwen | Step 3 |
| ファインチューニング | Unsloth + QLoRA + TRL (DPO) | 研究メモ |

## コスト試算 (月間)

| Step | Claude API | Gemma (ローカル) | 合計 |
|------|-----------|-----------------|------|
| 1-2 (Gemma主体) | ¥0 | 電気代のみ | ~¥0 |
| 3 (Claude併用時) | ~¥300 | 電気代のみ | ~¥300 |

---
---

# 研究メモ・将来構想 (優先度低)

以下は将来的に取り組む可能性があるが、Step 1-3の完成が前提。
アイデアと技術的な検討を記録しておく。

---

## スマホARゴーグル戦略

スマホをARゴーグル (¥1,000-3,000) に装着するだけで、今のGuideyがそのままARデバイスになる。
- 追加開発ゼロ (今のアプリがそのまま動く)
- 両手が完全に空く = DIY/料理に最適
- 将来のARグラスへの架け橋 (多くのARグラスはスマホミラーリング方式)
- ゴーグルモード時: フォント拡大、コントラスト強化、操作は100%音声、自動キャプチャ有効化

---

## ステーションモード (USBカメラ + Mac + iPad)

スマホ単体が基本だが、将来的に「据え置きモード」も対応する。

```
[ステーションモード]
  USBカメラ (三脚固定、俯瞰) → Mac (OpenCV + FastAPI)
    → Gemma 4 で解析 → WebSocket で iPad に配信

[スマホモード] ← 今の設計、開発の基本
  スマホのカメラ → FastAPI → Gemma 4 → スマホで表示+音声
```

**⚠️ 実装上の注意: 今から意識すること**
- `CameraView` は映像ソースを抽象化 (スマホカメラ / WebSocket受信を差し替え可能に)
- 画像解析のインターフェースは「画像バイト列を受け取る」に統一
- `/guide/analyze` は既に画像バイト列を受け取る設計 → ステーション時はバックエンドが直接カメラから取得
- オーバーレイUIはカメラソースに依存しない設計にする

---

## RAG自動洗練システム

### 品質ゲート (インデックス時)
- Gemma 4 でスコアリング (0.0-1.0)、0.3未満は自動除外

### ユーザーフィードバックループ
- 「役立った」→ スコア+0.1 / 「違う」→ スコア-0.2 / 無視 → -0.05
- スコア0.1以下 → 自動除外候補

### 検索ヒット率メトリクス
- 30日間未使用 → アーカイブ / 上位10% → ブースト
- メタデータ: quality_score, hit_count, last_hit_at, feedback_score

### 週次バッチ (LLM-as-Judge)
- Gemma 4 が既存データを再評価、重複マージ、低品質除外

---

## RAG既知の弱点と改善ロードマップ

現時点の設計で明確に不足している4領域。
**どこが弱いかを認識した上で段階的に改善する。**

### 1. Retrieval評価戦略が無い
- 評価指標: Recall@k, MRR, NDCG
- LLM-as-Judgeは「生成の評価」であって「検索の評価」ではない。別物。
- 段階的: 手動20件評価セット → Gemma 4で拡張 → RAGAS統合

### 2. Hybrid Searchが無い
- Dense検索のみだと「塩 小さじ1」のようなキーワード検索が弱い
- Dense (ColPali/embedding) + Sparse (BM25) + Reranker (BGE) が定石
- Milvus 2.4+ はHybrid Search対応
- 段階的: Dense のみ → BM25追加 → Reranker追加

### 3. チャンク戦略の設計が無い
- YouTube字幕: 工程ベース区切り (Gemma 4に任せる) が最有力
- 取説PDF: ColPaliならページ画像のままでOK
- レシピサイト: 1ステップ=1チャンクが基本
- 段階的: Gemma 4に任せる → 分割品質評価 → セマンティックチャンキング

### 4. Query Transformationが無い
- HyDE: 仮想回答生成→検索 / Multi-query: 複数クエリ→統合 / Step-back: 抽象化→検索
- Guideyの場合: ColPali直接検索 + Multi-query の組み合わせが最適
- 段階的: 単純クエリ → Multi-query → HyDE + ColPali全統合

---

## LoRA ファインチューニング (自分専用モデルを育てる)

### 概要
RAGデータ+フィードバックでGemma 4を「自分専用エキスパート」に育てる。

### 2段階学習
| 段階 | 手法 | データ | 効果 |
|------|------|-------|------|
| SFT | LoRA | RAG手順書 → (質問, 回答) | ドメイン知識注入 |
| DPO | LoRA | フィードバック → (chosen, rejected) | ユーザー好み最適化 |

### 技術スタック
- Unsloth (2-4x高速化) + QLoRA (4bit量子化) + TRL (DPO/SFTトレーナー)
- 36GB Macで動作可能、LoRAアダプタは数十MB → いつでもロールバック

### モデルの進化イメージ
```
Month 0: 汎用Gemma 4 → 「肉を焼いています」
Month 1: SFT LoRA    → 「中火で3分焼いて、焦げ目がついたら裏返してください」
Month 3: DPO LoRA    → 「いい焼き色です！あと1分で裏返しましょう」
Month 6: パーソナライズ → 「前回塩入れすぎてたので今回は少なめに」
```

### 学習パイプライン
```
日常利用 → RAG+フィードバック蓄積
  → 月次バッチ: Unsloth + QLoRA学習
  → LLM-as-Judge評価 → 改善あり → Ollama反映 / 悪化 → ロールバック
```

---

## 情報の断捨離ルール (ARグラス設計に直結)
- **音声で伝えるべき**: 次のアクション (「塩を入れましょう」)
- **視覚で見せるべき**: お手本画像、タイマー、進捗バー
- **両方**: 警告 (「火が強すぎます！」→ 赤いオーバーレイ + 音声)
