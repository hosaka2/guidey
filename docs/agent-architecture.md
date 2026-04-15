# 自律エージェント アーキテクチャ

Guidey の自律エージェント (LangGraph State Machine) の設計と実装の詳細。

---

## 全体像

ユーザーが何も操作しなくても、AIがカメラ越しに作業を見守り、適切なタイミングで指示を出す。

```
┌─ Mobile ─────────────────────────────────────────────┐
│  useAutonomousLoop (5秒間隔、適応的)                    │
│    カメラキャプチャ → POST /judge (画像送信)             │
│    ← JudgeResponse (judgment + blocks)               │
│    ↕ SharedState (plan, stepIndex, observations)      │
│  useSpeechRecognition (常時リッスン)                    │
│    音声Intent検出 → ステップ操作 / TTS制御              │
└──────────────────────────────────────────────────────┘
                    │ REST API (画像 + コンテキスト)
┌─ Backend (LangGraph 2段階) ──────────────────────────┐
│  Observe → Appraise → think_gemma → [can_handle?]    │
│                                      ├ Yes → Safety → Act │
│                                      └ No → think_hq → Safety → Act │
└──────────────────────────────────────────────────────┘
```

---

## LangGraph State Machine (2段階LLM)

### ノード (6段)

| ノード | 役割 | 処理内容 |
|--------|------|---------|
| **Observe** | 画像受信 | State に画像格納、ステップ開始時刻を記録 |
| **Appraise** | 意味的変化検知 | 画像→Gemmaキャプション生成→embedding→前回との類似度比較。手ブレに強い |
| **think_gemma** | Stage 1 判定 | Gemma e2b (高速) で3択判定 + can_handle + UIブロック出力 |
| **think_hq** | Stage 2 判定 | Gemma 26b (高品質) でエスカレーション処理。将来Claude対応 |
| **Safety Check** | 安全確認 | 危険キーワード→AlertBlock生成、低確信度anomalyブロック |
| **Act** | 実行 | ログ + 中期メモリ更新 (完了ステップ所要時間) |

### グラフ構造

```
Observe → Appraise → [変化あり?]
                       ├─ No → END (LLM呼び出しスキップ、コスト節約)
                       └─ Yes → think_gemma → [can_handle?]
                                               ├─ Yes → Safety Check → Act → END
                                               └─ No → think_hq → Safety Check → Act → END
```

### 2段階の判断フロー

**Stage 1 (think_gemma)**: Gemma e2b, think=False, ~2秒
- カメラ画像 + 現在のステップ情報で3択判定
- 自分で処理できるかを自己判定 (`can_handle`)
- UIブロック (テキスト、アラート等) も同時生成
- 大半の判定 (80-90%) はここで完結

**Stage 2 (think_hq)**: Gemma 26b, think=True, ~10秒 (将来: Claude)
- Gemmaが `can_handle=false` でエスカレーションした場合のみ
- より豊富なコンテキストで精度の高い判定
- Tool Calling 対応 (set_timer, send_alert 等)

### Gemma Stage 1 の出力スキーマ

```json
{
  "judgment": "continue|next|anomaly",
  "confidence": 0.0-1.0,
  "message": "状況の説明",
  "can_handle": true,
  "escalation_reason": "",
  "blocks": [
    {"type": "text", "content": "いい感じです", "style": "emphasis"}
  ]
}
```

### エスカレーション基準 (Gemmaのプロンプトに記載)

Gemmaが `can_handle=false` にするケース:
- プラン全体の変更が必要
- 複数の選択肢からの提案が必要
- 安全に関わる重要判断
- 判定に自信がない
- ユーザーの意図が複雑

---

## 変化検知 (Appraise)

手持ちカメラはブレるため、ピクセル比較やファイルサイズ比較では使えない。
**意味的変化検知**: 画像のキャプションを比較する。

1. Gemma (VLM) で画像の1文キャプションを生成
2. nomic-embed-text で埋め込み
3. 前回キャプション embedding とコサイン類似度を計算
4. **類似度 >= 0.90 → 変化なし** (手ブレ、同じ場面) → Think をスキップ
5. **類似度 < 0.90 → 変化あり** → Think で判定

メリット:
- 手ブレに強い (意味的変化のみ検出)
- 「同じ状態をずっと見ている」時のLLM判定の無駄呼び出しを削減

---

## UIブロック

LLMが返す構造化UI要素。モバイルアプリが描画する。

| ブロック | 用途 | 例 |
|---------|------|---|
| TextBlock | テキスト表示 | 指示、アドバイス (normal/emphasis/warning) |
| ImageBlock | 画像表示 | お手本画像 |
| VideoBlock | 動画再生 | 該当シーン |
| TimerBlock | タイマー | 煮込み3分 |
| AlertBlock | 通知 | 危険警告 (info/warning/danger) |

Safety Check で危険キーワード検出時は自動的に AlertBlock を追加。
ブロックはチャット風に蓄積、バツボタンで消去可能。

---

## State スキーマ (GuideState)

```python
class GuideState(TypedDict, total=False):
    # 入力
    image_bytes: bytes
    current_step_index: int
    plan_steps: list[PlanStep]
    user_transcript: str

    # 短期メモリ
    recent_observations: list[str]

    # 中期メモリ
    completed_steps: list[dict]
    step_started_at: str
    user_reports: list[str]

    # 長期メモリ参照
    user_id: str
    user_preferences: dict

    # 変化検知
    has_change: bool
    last_caption: str
    last_caption_embedding: list[float]

    # 2段階LLM
    can_handle: bool
    escalation_reason: str
    escalated: bool

    # UIブロック
    blocks: list[dict]

    # ハーネス
    safety_override: str
    safety_reason: str

    # モード
    is_calibration: bool

    # 出力
    judgment: str
    confidence: float
    message: str
```

---

## 3-Tier Memory

| 層 | 保持期間 | 内容 | 実装 |
|----|---------|------|------|
| **短期** | 直近3件 | 判定メッセージ | `recent_observations` (State内リスト) |
| **中期** | セッション中 | 完了ステップ、所要時間 | `completed_steps` (State内リスト) |
| **長期** | 永続 | ユーザー嗜好、失敗履歴 | SQLite (将来) |

---

## 安全確認 (ハーネス層)

### 危険キーワード検出

次のステップに進む際、テキストに以下が含まれれば AlertBlock を自動生成:

| キーワード | 警告 |
|-----------|------|
| 火 | 火を使う作業です。換気と消火器の確認を。 |
| 刃物 | 刃物を使います。手元に注意してください。 |
| 高所 | 高所での作業です。足場を確認してください。 |
| 電気 | 電気系統の作業です。ブレーカーを確認してください。 |
| 熱い | 高温注意。やけどに気をつけてください。 |
| 危険 | 危険な作業が検出されました。 |

### 低確信度ブロック

`anomaly` 判定で `confidence < 0.5` → `continue` に変更 (誤報を抑制)。

---

## 判定プロンプト (状態固定方式)

LLMに工程を自由推測させず、現在のステップを固定して3択で判定させる。

```
現在のステップ: {step_name}
次のステップ: {next_step_name}
直近の観察: {recent_observations}

画像を見て3択: continue / next / anomaly
加えて can_handle (自信があるか) と blocks (UIブロック) も出力。
```

---

## キャリブレーション

自律モード開始時に、カメラ画像から「今どのステップにいるか」を推定。

```
POST /judge?is_calibration=true
```

LLMに全ステップリストと画像を渡し、最も合致するステップ番号を返す。

---

## モバイル側: 自律ループ

### useAutonomousLoop

```
[タイマー発火] → カメラキャプチャ → POST /judge (画像送信)
  ← JudgeResponse (judgment + blocks)
  → "continue" → 間隔維持 or 延長
  → "next" (2回連続) → ステップ進行 + TTS + ブロック表示
  → "anomaly" → 警告TTS + ブロック表示
```

適応的サンプリング: 5秒 → 15秒 → 30秒 (変化なし連続時)
ヒステリシス: 2回連続 "next" でステップ進行

---

## 音声Intent (12種)

| カテゴリ | Intent | トリガーワード |
|---------|--------|-------------|
| 操作 | capture | 教えて |
| 操作 | next_step | 次、できた、オッケー |
| 操作 | previous_step | 戻して、前 |
| 操作 | skip | スキップ |
| 制御 | stop | ストップ、止めて |
| 制御 | pause | 待って |
| 制御 | resume | 再開、続き |
| 制御 | repeat | もう一回 |
| 対話 | question | これでいい、大丈夫 |
| 対話 | report_status | 切った、終わった |
| 対話 | request_help | 分からない、助けて |
| - | unknown | (4文字以上の不明発話) |

キーワードマッチで即応答 (LLM不要)。将来: unknownはGemma→Claudeの2段階で分類。

---

## Tool Calling

Stage 2 (think_hq) で利用可能なツール:

| ツール | 用途 | 戻り値 |
|--------|------|--------|
| set_timer | タイマーセット | TimerBlock |
| send_alert | 警告通知 | AlertBlock |
| show_image | 画像表示 | ImageBlock |
| show_text | テキスト表示 | TextBlock |

現在はプロンプト内でJSON出力させる方式。将来 `bind_tools` に移行予定。

---

## API エンドポイント

| メソッド | パス | 用途 |
|---------|------|------|
| POST | `/guide/analyze/stream` | 手動解析 (SSEストリーミング) |
| POST | `/guide/plan/generate` | プラン自動生成 |
| GET | `/guide/plan/{source_id}` | プラン取得 |
| POST | `/guide/judge` | 自律判定 (2段階LLM + UIブロック) |

### JudgeResponse

```json
{
  "judgment": "next",
  "confidence": 0.85,
  "message": "ステップ完了",
  "current_step_index": 2,
  "blocks": [{"type": "text", "content": "次に進みます", "style": "emphasis"}],
  "escalated": false
}
```

---

## ファイル構成

```
backend/src/
├── domain/guide/
│   ├── model.py           # ドメインモデル + 安全ルール (check_step_safety)
│   └── service.py         # プロンプト構築
├── application/guide/
│   ├── blocks.py          # UIブロック型 (Text, Image, Video, Timer, Alert)
│   ├── judge_use_case.py  # 自律判定 (LangGraph呼び出し)
│   ├── plan_use_case.py   # プラン自動生成 (Multi-Document Synthesis)
│   └── schemas.py         # JudgeResponse (blocks, escalated 含む)
├── infrastructure/
│   ├── agent/
│   │   ├── graph.py       # LangGraph 2段階 State Machine
│   │   └── tools.py       # ツール定義 (set_timer, send_alert 等)
│   └── repositories/
│       ├── feedback_repository.py  # SqliteFeedbackRepository
│       └── plan_repository.py      # FilePlanRepository

mobile/
├── hooks/
│   ├── useAutonomousLoop.ts    # 自律ループ (キャプチャ→judge→ブロック表示)
│   ├── useSpeechRecognition.ts # 音声Intent (14種)
│   └── useJudgeApi.ts          # Judge API + Plan生成 API
├── components/
│   ├── BlockRenderer.tsx       # ブロック描画 (switch by type)
│   ├── FeedbackButtons.tsx     # 👍👎 フィードバック
│   ├── StepFeedback.tsx        # 😊😐😞 ステップ評価
│   └── blocks/                 # 個別ブロック (Text, Image, Video, Timer, Alert)
└── types/
    ├── blocks.ts               # Block 型定義
    └── plan.ts                 # Plan, JudgeResponse 型
```
