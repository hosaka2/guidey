# Guidey

DIY・料理などの作業を、スマホカメラ画像と音声でAIがリアルタイムにガイドするアプリ

## プロジェクト概要

Guideyは、手を離した状態でも音声操作でAIの指示を受けられるハンズフリーアシスタントです。
「次」「できた」などのキーワードに反応し、その瞬間のカメラ画像をAIが解析して次のステップを音声で指示します。

### 主な特徴

- **音声トリガー**: デバイス側でキーワードを検知し、ハンズフリー操作を実現
- **画像解析**: キーワード検知時にカメラから静止画を1枚切り出し、Claude が状況を判断
- **モード切替**: DIY / 料理に応じてプロンプトと参照知識(RAG)を切り替え
- **音声合成(TTS)**: AIの指示をデバイスで読み上げ
- **低コスト設計**: 動画ではなく静止画1枚、ローカルChromaDBでコスト最小化

## アーキテクチャ

```
+---------------------------------------------+
|  Mobile (React Native / Expo)               |
|  - 音声トリガー (デバイス内キーワード検知)      |
|  - カメラ静止画キャプチャ                      |
|  - TTS 読み上げ                              |
+---------------------------------------------+
                    | REST API
+---------------------------------------------+
|  Backend (FastAPI)                          |
|  - 軽量DDD Architecture                     |
|  - LangChain + Claude 4.5 Sonnet            |
|  - モード別プロンプト切替                      |
+---------------------------------------------+
                    |
+---------------------------------------------+
|  RAG (ChromaDB - ローカル)                   |
|  - YouTube字幕テキスト保存                    |
|  - コスト0のベクトルDB                        |
+---------------------------------------------+
```

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| **Mobile** | React Native, Expo (TypeScript), expo-camera, expo-speech, expo-speech-recognition |
| **Backend** | FastAPI, Python 3.12, uv |
| **LLM** | Gemma 4 (Ollama) / Claude Sonnet ([LLM戦略](./docs/llm-strategy.md)) |
| **RAG** | Milvus Lite + BM25 ハイブリッド検索 ([RAG詳細](./docs/rag-architecture.md)) |
| **自律エージェント** | LangGraph State Machine ([エージェント詳細](./docs/agent-architecture.md)) |
| **API** | REST + SSE ストリーミング ([APIリファレンス](./docs/api-reference.md)) |
| **アーキテクチャ** | 軽量DDD ([モバイル詳細](./docs/mobile-architecture.md)) |
| **将来設計** | Claude エスカレーション, ColSmolVLM, パーソナライズ ([詳細](./docs/future-design.md)) |

## ディレクトリ構造

```
guidey/
├── backend/
│   ├── pyproject.toml
│   ├── scripts/                    # データパイプライン
│   │   ├── ingest_pipeline.py      # YouTube→RAG (search/batch/url)
│   │   └── feedback_batch.py       # 週次フィードバック反映
│   ├── src/
│   │   ├── main.py                 # FastAPI エントリポイント
│   │   ├── config.py               # 環境変数・設定
│   │   ├── common/                 # 共通ユーティリティ (json_utils等)
│   │   ├── domain/guide/           # ドメイン層 (モデル・安全ルール・サービス)
│   │   ├── application/guide/      # アプリケーション層 (UseCase・UIブロック・スキーマ)
│   │   ├── infrastructure/         # インフラ層
│   │   │   ├── agent/              #   LangGraph 2段階 State Machine
│   │   │   ├── llm/                #   LLMクライアント (Ollama/Claude)
│   │   │   ├── rag/                #   Milvus + BM25 ハイブリッド検索
│   │   │   └── repositories/       #   リポジトリ (SQLite, ファイルシステム)
│   │   └── routes/                 # APIルーター
│   ├── static/                     # 静的ファイル (テストデータ, 動画フレーム)
│   └── db/                         # データベース (.gitignore)
│
├── mobile/                         # Expo (TypeScript)
│   ├── app/                        # 画面 (tabs, goal, guide, settings)
│   ├── hooks/                      # カスタムフック (API, 音声, 自律ループ)
│   ├── components/                 # UIコンポーネント (BlockRenderer, Feedback等)
│   └── types/                      # 型定義 (Plan, Block)
│
└── docs/                           # ドキュメント
```

## セットアップ

### 前提条件

- Python 3.12+
- uv ([インストール](https://docs.astral.sh/uv/getting-started/installation/))
- Node.js 20+
- Expo CLI
- Ollama ([インストール](https://ollama.com/)) + Gemma 4 モデル

### 1. Ollama + Gemma 4 セットアップ

```bash
brew install ollama
brew services start ollama
ollama pull gemma4
```

### 2. 環境変数を設定

```bash
cp .env.example .env
# デフォルトで Gemma 4 (ローカル, コスト0) を使用
# Claude に切り替える場合は LLM_PROVIDER=anthropic に変更
```

### 3. Backend 起動

```bash
cd backend
uv sync
uv run uvicorn src.main:app --reload --port 8000
```

API ドキュメント: http://localhost:8000/docs

### 3. Mobile 起動（Expo Go）

UI確認のみ。音声認識などネイティブモジュールは動作しない。

```bash
cd mobile
npm install
npx expo start
```

### 4. Mobile 起動（Development Build / 実機）

音声認識（expo-speech-recognition）を含むフル機能テストには Development Build が必要。

#### 前提条件

- Xcode（iPhoneのiOSバージョンに対応するもの。iOS 26ベータなら Xcode 26ベータが必要）
- USBケーブル（初回のみ）
- iPhone と Mac が同じ Wi-Fi に接続されていること

#### iPhone 側の準備

1. **デベロッパモード有効化**: 設定 → プライバシーとセキュリティ → デベロッパモード → オン（再起動が必要）
2. **USBで Mac に接続**: 「このコンピュータを信頼」を許可

#### Xcode 署名設定

```bash
open mobile/ios/mobile.xcworkspace
```

1. 左パネルで mobile プロジェクトを選択
2. TARGETS → mobile → Signing & Capabilities
3. Team: Apple ID でログインし、自分のアカウントを選択
4. Bundle Identifier が `com.guidey.app` になっていることを確認

#### ビルド & 実行

```bash
cd mobile
npx expo install expo-dev-client   # 初回のみ
npx expo prebuild --clean          # 初回 or ネイティブ設定変更時
npx expo run:ios --device
```

#### よくあるトラブル

| 症状 | 対処 |
|------|------|
| `No code signing certificates` | Xcode で署名設定をする（上記手順） |
| `Developer Mode disabled` | iPhone: 設定 → プライバシーとセキュリティ → デベロッパモード → オン |
| `信頼されていないデベロッパ` | iPhone: 設定 → 一般 → VPNとデバイス管理 → 証明書を信頼 |
| `developer disk image could not be mounted` | XcodeのバージョンがiOSに対応していない。Xcode更新が必要 |
| `Error loading app` / 接続できない | iPhone: 設定 → プライバシーとセキュリティ → ローカルネットワーク → アプリを許可 |
| Macのファイアウォール | 設定 → ネットワーク → ファイアウォール → オフにするか Node.js を許可 |

## 開発ロードマップ

### Step 1: MVP
画像1枚 + ボタン操作で「対話」を成立させる。Gemma 4 (ローカル) でコスト0。

### Step 2: 音声トリガー + オーバーレイUI
ハンズフリー音声操作 + カメラ映像上にお手本画像やタイマーを半透明表示。

### Step 3: 自律エージェント化
自動キャプチャ + LangGraph + RAG (Milvus Lite) で、ユーザーが何も言わなくてもAIが作業を見守り自律的に指示する。

詳細は [plan.md](./plan.md) を参照。
