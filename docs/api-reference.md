# API リファレンス

Backend FastAPI エンドポイントの仕様。

Base URL: `http://{host}:8000/guide`

---

## エンドポイント一覧

| メソッド | パス | 用途 |
|---------|------|------|
| POST | `/guide/analyze` | 画像解析 (同期) |
| POST | `/guide/analyze/stream` | 画像解析 (SSEストリーミング) |
| POST | `/guide/plan/generate` | プラン自動生成 |
| GET | `/guide/plan/{source_id}` | プラン取得 |
| POST | `/guide/judge` | 自律判定 (2段階LLM) |
| POST | `/guide/feedback` | フィードバック送信 |
| GET | `/guide/plan/{source_id}` | プラン取得 |
| POST | `/guide/judge` | 自律判定 (3択) |

---

## POST /guide/analyze

画像を解析し、次のステップ指示を返す。

### リクエスト (multipart/form-data)

| フィールド | 型 | 必須 | 説明 |
|-----------|---|------|------|
| file | File | ✅ | 画像ファイル (JPEG/PNG/WebP, max 10MB) |
| mode | string | ✅ | `"diy"` or `"cooking"` |
| trigger_word | string | ✅ | トリガーワード (例: `"教えて"`) |
| goal | string | | ユーザーのゴール |

### レスポンス (JSON)

```json
{
  "instruction": "玉ねぎをみじん切りにしましょう。",
  "mode": "cooking",
  "reference_image_url": "/static/videos/xxx/frames/step_01_mid.jpg",
  "current_step": 3,
  "total_steps": 8
}
```

---

## POST /guide/analyze/stream

SSEストリーミングで画像解析結果を返す。

### リクエスト

`/guide/analyze` と同じ。

### レスポンス (text/event-stream)

```
data: {"type":"meta","reference_image_url":"/static/...","current_step":1,"total_steps":8,"steps":[{"step_number":1,"text":"...","frame_url":"..."}]}

data: "テキストチャンク1"

data: "チャンク2"

data: [DONE]
```

- 最初の `data:` はメタ情報 (JSON、`type: "meta"`)
- テキストチャンクはJSON文字列 (改行保持のため `json.dumps()`)
- 終了は `[DONE]`

---

## POST /guide/plan/generate

ゴールテキストからステップリストを自動生成。

### リクエスト (JSON)

```json
{
  "goal": "肉じゃがを作る",
  "mode": "cooking"
}
```

### レスポンス (JSON)

```json
{
  "source_id": "generated-a50dfcce",
  "title": "肉じゃがを作る",
  "steps": [
    {
      "step_number": 1,
      "text": "玉ねぎを薄切りにする",
      "visual_marker": "玉ねぎが薄く均等にスライスされている",
      "frame_url": "/static/videos/xxx/frames/step_02_mid.jpg"
    }
  ]
}
```

- `source_id`: 生成されたプランの一意ID (`generated-{hash}`)
- `frame_url`: RAGから検索されたお手本画像 (なければ空文字)
- 同一ゴールはメモリキャッシュから即返却

---

## GET /guide/plan/{source_id}

プランを取得。静的ファイル (`static/manual/`) と生成キャッシュの両方を検索。

### レスポンス

`POST /guide/plan/generate` と同じ形式。

### エラー

```json
{"detail": "プラン 'xxx' が見つかりません"}  // 404
```

---

## POST /guide/judge

カメラ画像を見て3択判定。自律モードで使用。

### リクエスト (multipart/form-data)

| フィールド | 型 | 必須 | 説明 |
|-----------|---|------|------|
| file | File | ✅ | カメラ画像 |
| plan_source_id | string | ✅ | プランの source_id |
| current_step_index | int | ✅ | 現在のステップインデックス (0-based) |
| recent_observations | string | | JSON配列文字列 `["観察1","観察2"]` |
| is_calibration | string | | `"true"` で開始ステップ推定モード |

### レスポンス (JSON)

```json
{
  "judgment": "next",
  "confidence": 0.85,
  "message": "ステップ完了",
  "current_step_index": 0,
  "blocks": [{"type": "text", "content": "次に進みます", "style": "emphasis"}],
  "escalated": false
}
```

- `judgment`: `"continue"` / `"next"` / `"anomaly"` / `"calibrated"` (キャリブレーション時)
- `confidence`: 0.0-1.0
- `current_step_index`: キャリブレーション時は推定されたインデックス
- `blocks`: UIブロック配列 (TextBlock, AlertBlock等)
- `escalated`: 2段目 (HQ) で処理されたか

---

## POST /guide/feedback

フィードバックを送信。

### リクエスト (JSON)

```json
{
  "target_type": "utterance",
  "sentiment": "negative",
  "source": "voice",
  "target_content": "前回の指示内容",
  "raw_content": "違う",
  "step_index": 3
}
```

| フィールド | 型 | 必須 | 説明 |
|-----------|---|------|------|
| target_type | string | ✅ | `"utterance"` / `"step"` / `"plan"` / `"session"` |
| sentiment | string | ✅ | `"positive"` / `"neutral"` / `"negative"` / `"plan_retry"` |
| source | string | ✅ | `"voice"` / `"tap"` |
| target_id | string | | 対象ID |
| target_content | string | | 対象の内容 |
| raw_content | string | | 音声の文字起こし等 |
| step_index | int | | ステップ番号 |

### レスポンス (JSON)

```json
{
  "feedback_id": "a1b2c3d4",
  "status": "ok"
}
```

`plan_retry` の場合は自動的に失敗プランも記録される。

---

## 共通仕様

### 画像バリデーション

- 対応形式: JPEG, PNG, WebP
- 最大サイズ: 10MB
- 不正な形式 → 400 Bad Request

### エラーレスポンス

```json
{
  "detail": "エラーメッセージ"
}
```

| ステータス | 説明 |
|-----------|------|
| 400 | バリデーションエラー (画像形式、パラメータ) |
| 404 | プランが見つからない |
| 500 | 内部エラー (LLM接続失敗等) |
