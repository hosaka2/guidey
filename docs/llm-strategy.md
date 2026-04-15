# LLM 戦略

モデルの使い分け、プロバイダー切り替え、コスト管理の設計。

---

## モデル使い分け

### 原則: 頻度と精度のトレードオフ

| 条件 | 高品質モデル (Claude) | ローカルLLM (Gemma) |
|------|---------------------|-------------------|
| 呼び出し頻度 | 数回/セッション | 数百回/セッション |
| 失敗が後続に伝播する | ✅ | |
| 構造化出力の正確性が重要 | ✅ | |
| レイテンシ < 1秒 | | ✅ |
| プライバシー重視 (生カメラ画像) | | ✅ |
| 失敗してもリカバリー可能 | | ✅ |

### 用途別モデル割り当て

| 用途 | モデル | 理由 |
|------|--------|------|
| **ステップ生成** (セッション開始) | Gemma 4 (将来: Claude) | 精度が全体を決める |
| **実行時3択判定** (数秒ごと) | Gemma 4 | 高速・無料 |
| **visual_marker改善** (データ登録) | Gemma 4 (VLM) | フレーム画像を見る |
| **詳細キャプション生成** (データ登録) | Gemma 4 (VLM) | フレーム画像を記述 |
| **品質スコアリング** (データ登録) | Gemma 4 | バッチ処理 |
| **音声Intent分類** (将来) | Gemma 4 | 低レイテンシ |

---

## LLMクライアント アーキテクチャ

### Protocol ベースの抽象化

```python
class LLMClient(Protocol):
    async def analyze_image(self, image_bytes: bytes, system_prompt: str) -> str: ...
    async def analyze_image_stream(self, image_bytes: bytes, system_prompt: str) -> AsyncIterator[str]: ...
    async def generate_text(self, system_prompt: str) -> str: ...
```

3つのメソッド:
- `analyze_image`: 画像 + テキスト → テキスト (同期)
- `analyze_image_stream`: 画像 + テキスト → テキストストリーム (SSE用)
- `generate_text`: テキスト → テキスト (画像なし、プラン生成等)

### 実装クラス

```
LLMClient (Protocol)
  └── BaseLangChainClient (共通実装)
       ├── OllamaClient (高速: Gemma e2b, think=False, 4K ctx)
       ├── OllamaHQClient (高品質: Gemma 26b or e2b, 将来Claude代替)
       └── ClaudeClient (Claude Sonnet, API)
```

`BaseLangChainClient` が LangChain の `BaseChatModel` を使い、base64画像エンコード等の共通処理を担当。

### プロバイダー切り替え

`backend/.env`:
```bash
LLM_PROVIDER=ollama          # "ollama" or "anthropic"
OLLAMA_MODEL=gemma4:e2b      # ローカルモデル名
ANTHROPIC_API_KEY=sk-...     # Claude使用時
ANTHROPIC_MODEL=claude-sonnet-4-5-20250514
```

Factory パターンで自動選択:
```python
# infrastructure/llm/factory.py
def get_llm_client() -> LLMClient:       # 高速版 (リアルタイム)
    ...
def get_hq_llm_client() -> LLMClient:    # 高品質版 (RAG/プラン)
    ...
```

### 新プロバイダーの追加方法

1. `infrastructure/llm/` に新クラス作成 (例: `gemini.py`)
2. `BaseLangChainClient` を継承
3. `__init__` で対応する LangChain ChatModel を設定
4. `factory.py` に分岐を追加

---

## Ollama 設定

### コンテキスト長

`OllamaClient` で `num_ctx=4096` に制限。デフォルト32768は遅すぎる。

```python
ChatOllama(model=settings.ollama_model, num_ctx=4096)
```

### 推奨モデル

| モデル | サイズ | 速度 | 品質 | 用途 |
|--------|-------|------|------|------|
| `gemma4:e2b` | ~3GB | 速い | 中 | 実行時判定 |
| `gemma4:latest` | ~10GB | 普通 | 高 | データ登録時 |
| `gemma4:26b` | ~17GB | 遅い | 最高 | オフライン処理 |

---

## コスト試算

### ローカル運用 (Ollama のみ)

| 用途 | 月間呼び出し | コスト |
|------|------------|--------|
| ステップ生成 | ~30回 | ¥0 |
| 実行時判定 | ~3000回 | ¥0 |
| データ登録 | ~10回 | ¥0 |
| **合計** | | **¥0** (電気代のみ) |

### ハイブリッド運用 (Ollama + Claude)

| 用途 | モデル | 月間呼び出し | コスト |
|------|--------|------------|--------|
| ステップ生成 | Claude Sonnet | ~30回 | ~¥100 |
| 実行時判定 | Gemma 4 | ~3000回 | ¥0 |
| データ登録 | Gemma 4 | ~10回 | ¥0 |
| **合計** | | | **~¥100/月** |

---

## ファイル構成

```
backend/src/infrastructure/llm/
├── base.py       # LLMClient Protocol + BaseLangChainClient
├── ollama.py     # OllamaClient (高速) + OllamaHQClient (高品質)
├── claude.py     # ClaudeClient (Claude Sonnet)
└── factory.py    # get_llm_client() + get_hq_llm_client()
```
