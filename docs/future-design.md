# 将来の設計方針 (未実装)

実装済みの基盤に対して、今後追加予定の機能と設計をまとめる。

---

## 1. UIブロック拡張

現在: TextBlock, ImageBlock, VideoBlock, TimerBlock, AlertBlock の 5 種

### 追加候補
| ブロック | 用途 |
|---------|------|
| ChoiceBlock | 選択肢提示 (代替案等) |
| ChecklistBlock | 材料チェックリスト |
| ComparisonBlock | 現状 vs お手本 比較 |
| ProgressBlock | 進捗バー |

### 双方向通信
- UserAction でフロント → バック通知
- ChoiceBlock の選択結果でプラン修正

---

## 2. マルチモーダル検索の進化

現在: Caption-based (Gemma キャプション → nomic-embed-text)
将来: 画像直接埋め込み

| Phase | モデル | 方式 |
|-------|-------|------|
| 現在 | nomic-embed-text + Gemma | キャプションベース |
| 次 | ColSmolVLM | Late Interaction (軽量) |
| 最終 | ColPali | Late Interaction (最高精度) |

embedding 関数を差し替えるだけで移行可能。

---

## 3. フィードバック活用拡張

現在: 収集 (音声検出 + UI タップ) + SQLite 保存
将来:

### RAG 自動洗練
- 週次バッチで negative 多数のチャンクを自動降格
- plan_retry のソースを Multi-Document Synthesis で除外

### 学習データ生成
- SFT: 高評価の (状況, 発話) ペア → 学習データ
- DPO: 同一文脈の positive/negative → chosen/rejected
- LoRA ファインチューニング (Unsloth + QLoRA)

---

## 4. パーソナライズ

現在: SQLite スキーマのみ (users, user_preferences, user_sessions)

### Phase 1: 利用履歴ベースの再ランキング
### Phase 2: ユーザー固有 RAG (自分のレシピ本をインデックス)
### Phase 3: 嗜好自動学習 (ジャンル、苦手な作業、失敗傾向)

---

## 5. プラットフォーム拡張

### ステーションモード
- USB カメラ (三脚固定) + Mac + iPad + WebSocket 配信

### スマートグラス空間 UI (Phase 2)
- 現状は Unity アダプタで Eye カメラ撮影のみ動作 (Phase 1)
- 将来は Unity 側に空間アンカー読出 / 3D prefab 描画を追加
- 詳細は [docs/xreal-unity-integration.md](xreal-unity-integration.md) 参照

---

## 6. 検索品質評価

現在: 評価基盤なし

- Recall@k, MRR, NDCG
- 手動 20 件評価セット → Gemma で拡張 → RAGAS 統合
- クエリ変換 (HyDE, Multi-query)
