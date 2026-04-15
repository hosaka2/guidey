# 将来の設計方針 (未実装)

実装済みの基盤に対して、今後追加予定の機能と設計をまとめる。

---

## 1. Claude エスカレーション

現在: Gemma 1段目 + Gemma HQ 2段目 (同一モデル)
将来: 2段目を **Claude Sonnet API** に置き換え。

- `config.py` の `llm_provider` を `anthropic` に、`ollama_hq_model` を Claude に変更するだけ
- Tool Calling を Claude の `bind_tools` で本格活用
- プラン修正、複雑な質問、安全判断でClaude の精度が活きる
- つなぎ発話: Gemma が「少し考えますね」→ バックグラウンドで Claude

### コスト想定
| 用途 | 頻度 | コスト |
|------|------|--------|
| エスカレーション判定 | ~10回/セッション | ~¥50 |
| プラン修正 | ~2回/セッション | ~¥20 |
| 月合計 | | ~¥500-1000 |

---

## 2. UIブロック拡張

現在: TextBlock, ImageBlock, VideoBlock, TimerBlock, AlertBlock の5種
将来: より豊富なブロックタイプ

### 追加候補
| ブロック | 用途 |
|---------|------|
| NutritionBlock | カロリー・栄養情報 |
| ChoiceBlock | 選択肢提示 (代替案等) |
| ChecklistBlock | 材料チェックリスト |
| ComparisonBlock | 現状 vs お手本 比較 |
| ProgressBlock | 進捗バー |

### 双方向通信
- UserAction でフロント → バック通知
- ChoiceBlock の選択結果でプラン修正

---

## 3. マルチモーダル検索の進化

現在: Caption-based (Gemma キャプション → nomic-embed-text)
将来: 画像直接埋め込み

| Phase | モデル | 方式 | Mac対応 |
|-------|-------|------|---------|
| 現在 | nomic-embed-text + Gemma | キャプションベース | ✅ |
| 次 | ColSmolVLM | Late Interaction (軽量) | MPS で動作見込み |
| 最終 | ColPali | Late Interaction (最高精度) | GPU推奨 |

embedding 関数を差し替えるだけで移行可能。

---

## 4. フィードバック活用拡張

現在: 収集 (音声検出 + UIタップ) + 週次バッチスクリプト
将来:

### RAG自動洗練
- 週次バッチで negative 多数のチャンクを自動降格
- plan_retry のソースを Multi-Document Synthesis で除外

### 学習データ生成
- SFT: 高評価の (状況, 発話) ペア → 学習データ
- DPO: 同一文脈の positive/negative → chosen/rejected
- LoRA ファインチューニング (Unsloth + QLoRA)

---

## 5. パーソナライズ

現在: SQLite スキーマのみ (users, user_preferences, user_sessions)
将来:

### Phase 1: 利用履歴ベースの再ランキング
- 過去に使った/評価したチャンクでRAG再ランキング

### Phase 2: ユーザー固有RAG
- 自分のレシピ本をインデックス
- `owner_user_id` で公開/個人データを切り替え

### Phase 3: 嗜好自動学習
- よく作るジャンル、苦手な作業、失敗傾向を推定
- プラン生成時にユーザー嗜好を反映

---

## 6. プラットフォーム拡張

### ARゴーグルモード
- スマホをARゴーグルに装着
- フォント拡大、コントラスト強化
- 100%音声操作

### ステーションモード
- USBカメラ (三脚固定) + Mac + iPad
- WebSocket で配信
