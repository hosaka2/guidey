# 将来の設計方針 (未実装)

実装済みの基盤に対して、今後追加予定の機能と設計をまとめる。

---

## 1. Claude エスカレーション

現在: Gemma 1段目 + Gemma HQ 2段目 (同一モデル)
将来: 2段目を **Claude Sonnet API** に置き換え。

- `config.py` の `llm_provider` を `anthropic` に変更するだけ
- 統一パイプラインの `hq_client` が Claude に切り替わる
- プラン修正、複雑な質問、安全判断で Claude の精度が活きる

### コスト想定
| 用途 | 頻度 | コスト |
|------|------|--------|
| エスカレーション判定 | ~10回/セッション | ~¥50 |
| プラン修正 | ~2回/セッション | ~¥20 |
| 月合計 | | ~¥500-1000 |

---

## 2. エッジLLM (スマホ上で Gemma 4 E2B)

### なぜエッジか

BEのローカルLLM (Ollama) は開発中は手元のMacで動くが、プロダクションではホスト先が問題になる。
GPU付きクラウドインスタンスはClaudeのAPI費用と大差ない。
**エッジ (スマホ上) で動かせば LLM 推論コストが完全にゼロ**。BE はセッション管理とStage 2 (クラウドLLM) 専用。

```
現在の問題:
  スマホ → [ネットワーク] → BE (Ollama on ???)
  ??? = 開発Mac / GPU Cloud / ??? ← ホスト先が決まらない

エッジ解決:
  スマホ (Gemma 4 E2B) → ローカル判定 → ゼロコスト
  BE → セッション + Stage 2 (Claude API) のみ → 安い VPS で十分
```

### アーキテクチャ

```
┌─ Mobile ─────────────────────────────────────────┐
│                                                   │
│  Camera → useEdgeLLM (llama.rn)                   │
│    → Gemma 4 E2B (on-device, ~1.5GB GGUF)        │
│    → continue/next/anomaly 判定                    │
│    → UI 即更新 + TTS                              │
│                                                   │
│  10秒間隔: POST /judge/sync                        │
│    → session 同期 (observations, step進行)         │
│    ← pending drain (Stage 2 結果)                  │
│    ← session 最新状態                              │
│                                                   │
│  エスカレーション: POST /chat                       │
│    → BE で Stage 2 (Claude) + Tool Calling         │
│                                                   │
│  Settings: [エッジLLM ON/OFF]                      │
│    OFF → 従来の POST /judge (BE で Stage 1)        │
└──────────────────────┬────────────────────────────┘
                       │ REST API (sync + escalation のみ)
┌─ Backend (安い VPS) ─┴────────────────────────────┐
│  Valkey: session 管理                              │
│  Stage 2: Claude API (エスカレーション時のみ)        │
│  RAG: Milvus Lite                                  │
│  Ollama: 不要 (エッジ ON 時)                        │
└───────────────────────────────────────────────────┘
```

### Mobile 実装詳細

#### useEdgeLLM hook (新規)

```typescript
// hooks/useEdgeLLM.ts
type EdgeLLMResult = {
  judgment: "continue" | "next" | "anomaly";
  confidence: number;
  message: string;
  can_handle: boolean;
  escalation_reason?: string;
};

function useEdgeLLM(enabled: boolean) {
  const modelRef = useRef<LlamaContext | null>(null);

  // モデルロード (Settings ON 時)
  useEffect(() => {
    if (!enabled) return;
    initContext({
      model: "file:///path/to/gemma4-e2b-q4_k_m.gguf",
      n_ctx: 2048,       // コンテキスト長 (エッジ向けに短く)
      n_gpu_layers: 99,   // GPU 全層オフロード
    }).then(ctx => modelRef.current = ctx);
    return () => modelRef.current?.release();
  }, [enabled]);

  // 推論
  const judge = useCallback(async (
    imageBase64: string,
    prompt: string,
  ): Promise<EdgeLLMResult> => {
    const ctx = modelRef.current;
    if (!ctx) throw new Error("Model not loaded");
    const response = await ctx.completion({
      prompt,
      n_predict: 256,
      temperature: 0.1,
      stop: ["}"],  // JSON 出力の末尾で停止
    });
    return parseJSON(response.text + "}");
  }, []);

  return { isReady: !!modelRef.current, judge };
}
```

#### useAutonomousLoop への統合

```typescript
// エッジ ON: ローカル判定 → 10秒ごとに BE sync
// エッジ OFF: 従来の POST /judge (3秒間隔)

const runOnce = useCallback(async () => {
  const uri = await cameraRef.current?.takePicture();
  if (!uri) return;

  if (edgeLLM.isReady && edgeEnabled) {
    // --- エッジ推論 ---
    const imageBase64 = await readAsBase64(uri);
    const prompt = buildPeriodicPrompt(currentStep, nextStep, observations);
    const result = await edgeLLM.judge(imageBase64, prompt);

    // 即座に UI 更新
    handleJudgeResult(result);

    // can_handle=false → BE にエスカレーション
    if (!result.can_handle) {
      await callChat(apiUrl, result.escalation_reason, uri, sessionId);
    }
  } else {
    // --- 従来: BE に送信 ---
    await callJudge(apiUrl, uri, sessionId);
  }
}, [...]);

// 10秒間隔で BE に同期 (エッジ ON 時)
useEffect(() => {
  if (!edgeEnabled || !sessionId) return;
  const timer = setInterval(async () => {
    const syncResult = await callJudgeSync(apiUrl, sessionId, {
      current_step_index: currentStepIndex,
      observations: recentObservations,
    });
    // pending があれば表示
    if (syncResult.pending_message || syncResult.pending_blocks?.length) {
      showBlocks(syncResult.pending_blocks);
      agentSpeak(syncResult.pending_message, "periodic");
    }
  }, 10000);
  return () => clearInterval(timer);
}, [edgeEnabled, sessionId]);
```

### BE 実装詳細

#### /judge/sync エンドポイント

```python
@router.post("/judge/sync")
async def judge_sync(
    session_id: str = Form(...),
    current_step_index: int = Form(0),
    observations: str = Form("[]"),
    store: ValkeySessionStore = Depends(get_session_store),
):
    """エッジ LLM 用セッション同期。LLM 推論はしない。"""
    session = await _get_session(session_id, store)

    # エッジ側の判定結果でセッション更新
    obs_list = json.loads(observations)
    for obs in obs_list:
        session.add_observation(obs)
    if current_step_index != session.current_step_index:
        session.current_step_index = current_step_index
        session.step_started_at = datetime.now().isoformat()

    # pending drain (Stage 2 バックグラウンド結果)
    pending_msg, pending_blocks = await store.drain_pending(session_id)

    await store.save(session)

    return {
        "pending_message": pending_msg,
        "pending_blocks": pending_blocks,
        "session": {
            "current_step_index": session.current_step_index,
            "total_steps": session.total_steps,
            "recent_observations": session.recent_observations,
        },
    }
```

### プロンプト最適化 (エッジ向け)

エッジ LLM はコンテキスト長が短い (2048 tokens)。専用の短いプロンプトが必要:

```
prompts/periodic_stage1_edge/v1.md  ← エッジ専用 (短縮版)
```

```markdown
画像を見てステップの進捗を判定。
ステップ{step_number}: {step_text}
目印: {visual_marker}

判定: continue(継続) / next(完了) / anomaly(異常)
問題あればmessageに記入。なければ空。
自信なければcan_handle:false。

JSON: {"judgment":"...", "confidence":0.0-1.0, "message":"", "can_handle":true}
```

通常版 (620文字) → エッジ版 (200文字) に圧縮。

### モデル管理

```
モデルファイル:
  gemma4-e2b-q4_k_m.gguf  (~1.5GB, 4bit量子化)

ダウンロード:
  Settings → エッジLLM ON → 初回のみダウンロード
  保存先: FileSystem.documentDirectory + "/models/"
  進捗表示: ProgressBar (expo-file-system)

バージョン管理:
  AsyncStorage に { model_version, model_path, downloaded_at }
  BE に /models/latest で最新バージョン確認 → 差分あれば更新

オンオフ
  Settings → エッジLLM OFF → オフの場合は従来のBEでの2段階

削除:
  Settings → エッジLLM 削除 → モデル削除してストレージ解放
```

### モデル

llama.rn (llama.cpp):
- https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF
- おそらくこれ

```
Phase 1: テキストのみ (画像入力なし)
  → ステップ情報 + observations で 3択判定
  → 精度は下がるが動作する
  → 「さっき玉ねぎ切ってた → まだ切ってる → continue」

Phase 2: VLM 対応
  → Gemma 4 VLM の GGUF が利用可能になり次第
  → llama.rn の multimodal API で画像入力
  → 精度が BE 版と同等に
```

### バッテリー影響

| 設定 | GPU使用 | 推定消費 |
|------|---------|---------|
| 10秒間隔、テキストのみ | 低 (推論 ~0.5秒) | ~5%/時間 |
| 10秒間隔、VLM | 中 (推論 ~2秒) | ~10%/時間 |
| 5秒間隔、VLM | 高 | ~15%/時間 (非推奨) |

30分セッション: テキストのみ ~2.5%、VLM ~5%。許容範囲。

### コスト比較

| 構成 | Stage 1 | Stage 2 | BE ホスト | 月額 |
|------|---------|---------|----------|------|
| **現在** (Ollama on Mac) | Gemma (ローカル) | Gemma (ローカル) | Mac (電気代) | ~¥0 |
| **Cloud Ollama** | Gemma (GPU Cloud) | Gemma (GPU Cloud) | GPU VPS | ~¥5,000-10,000 |
| **Cloud Claude** | Claude API | Claude API | 安い VPS | ~¥3,000-5,000 |
| **エッジ + Claude** | **Gemma (スマホ)** | **Claude API** | **安い VPS** | **~¥500-1,000** |

エッジ + Claude が最安。Stage 1 (95%の呼び出し) がゼロコスト、Stage 2 (5%) だけ Claude API。

### 段階的導入

1. **Phase 1**: llama.rn 統合
　  - モデルダウンロード + ロード機構
   - useEdgeLLM hook
   - /judge/sync エンドポイント
   - Settings トグル
   - Gemma 4 VLM の GGUF 入手
   - llama.rn の multimodal API 利用
   - 画像リサイズ (384px、エッジ向け)

2. **Phase 2**: 最適化
   - エッジ専用短縮プロンプト
   - 量子化チューニング (Q4_K_M vs Q5_K_M)
   - バッテリー最適化 (アダプティブ間隔)
   - オフラインモード (BE 接続なしでも基本判定可能)

エッジ経路は **cloud / gemma-local (llama.rn + Gemma 4 E2B VLM)** の 2 パターンで Settings から切替。
Apple FoundationModels は画像入力をサポートしないため VLM 用途では採用しない
(Vision framework + LM の二段構成は本来の VLM として成立しないため)。

---

## 3. UIブロック拡張

現在: TextBlock, ImageBlock, VideoBlock, TimerBlock, AlertBlock の5種

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

## 4. マルチモーダル検索の進化

現在: Caption-based (Gemma キャプション → nomic-embed-text)
将来: 画像直接埋め込み

| Phase | モデル | 方式 |
|-------|-------|------|
| 現在 | nomic-embed-text + Gemma | キャプションベース |
| 次 | ColSmolVLM | Late Interaction (軽量) |
| 最終 | ColPali | Late Interaction (最高精度) |

embedding 関数を差し替えるだけで移行可能。

---

## 5. フィードバック活用拡張

現在: 収集 (音声検出 + UIタップ) + SQLite保存
将来:

### RAG自動洗練
- 週次バッチで negative 多数のチャンクを自動降格
- plan_retry のソースを Multi-Document Synthesis で除外

### 学習データ生成
- SFT: 高評価の (状況, 発話) ペア → 学習データ
- DPO: 同一文脈の positive/negative → chosen/rejected
- LoRA ファインチューニング (Unsloth + QLoRA)

---

## 6. パーソナライズ

現在: SQLite スキーマのみ (users, user_preferences, user_sessions)

### Phase 1: 利用履歴ベースの再ランキング
### Phase 2: ユーザー固有RAG (自分のレシピ本をインデックス)
### Phase 3: 嗜好自動学習 (ジャンル、苦手な作業、失敗傾向)

---

## 7. プラットフォーム拡張

### ARゴーグルモード
- スマホをARゴーグルに装着、100%音声操作

### ステーションモード
- USBカメラ (三脚固定) + Mac + iPad + WebSocket配信

---

<a id="xreal-unity-adapter"></a>
## 7.5 XREAL (Beam Pro + 1S + Eye) — Unity アダプタ経路

**背景**: XREAL は公式の Android Native SDK を持たず Unity SDK のみ提供。
直接 Kotlin/Java からカメラ・空間アンカーを叩く経路は存在しないため、
**最小 Unity プロジェクトを SDK アダプタ層として挟む**方針を採用。

RN 本体のコードはほぼ変更せず、camera source (`xreal-eye`) の切替で
Unity 経由の経路を使う。将来の 3D 表示 / 空間アンカー拡張も同じ Unity プロジェクトを育てるだけで足りる。

### アーキテクチャ

```
┌─ RN (guidey 本体) ────────────────────────────┐
│  UI / LLM / API / 音声 — 既存のまま           │
│                                                │
│  lib/xreal/ ★ アダプタ                        │
│   ├─ bridge.ts          singleton、JSON 相関ID │
│   ├─ camera.ts          captureXrealFrame()    │
│   ├─ UnityBridgeView    _layout で 1×1 mount   │
│   └─ types.ts           request/response 型    │
│                                                │
│  useCameraCapture(ref): xreal-eye → bridge 経由│
└───────────────┬────────────────────────────────┘
                │ @azesmway/react-native-unity
                │  (postMessage / onUnityMessage)
┌───────────────▼─ Unity (mobile/unity/) ───────┐
│  最小シーン 1 枚 + アダプタ MonoBehaviour 群   │
│                                                │
│  Assets/Scripts/                               │
│   ├─ UnityInterop.cs     SendToRN 薄ラッパ     │
│   ├─ CameraBridge.cs     NRRGBCamTexture 取得  │
│   ├─ (future) SpatialBridge.cs   anchors取得  │
│   └─ (future) RenderBridge.cs    3D prefab描画│
│                                                │
│  XREAL SDK 3.0+ (公式 Unity パッケージ)        │
└────────────────────────────────────────────────┘
```

### プロトコル

JSON + 相関 ID (UUID) で request-response 化。タイムアウト 3-5 秒。

```json
// RN → Unity
{ "id": "ab12-cd34", "method": "Capture", "args": {} }

// Unity → RN (成功)
{ "id": "ab12-cd34", "kind": "camera",
  "data": "{\"uri\":\"file:///data/.../frame-xxx.jpg\"}" }

// Unity → RN (失敗)
{ "id": "ab12-cd34", "kind": "camera",
  "error": "camera not ready" }
```

Unity の `JsonUtility` はネスト JSON を文字列として持つ仕様なので、`data` は文字列で包む。
bridge.ts 側で JSON.parse して正規化。

### 段階的ロードマップ

| Phase | Unity 側 | RN 側 | Unity View サイズ |
|---|---|---|---|
| **1. カメラ** (今ここ) | CameraBridge.cs で RGB Eye フレーム取得 | useCameraCapture が xreal-eye 経路で bridge.capture() を呼ぶ | **1×1 hidden** |
| **2. 空間アンカー読出** | SpatialBridge.cs: anchors / planes 列挙、変更時に push | RN が anchors リストを持ち、LLM プロンプトに注入 (「anchor #3 = 作業台」等) | 1×1 hidden のまま |
| **3. 3D 描画** | RenderBridge.cs: DrawArrow(anchor_id, pose, text) 等の primitive | LLM が「anchor #3 に矢印」と返したら bridge.draw() を呼ぶ | **全画面 transparent** に切替 (光学シースルーで現実に重畳) |
| **4. 永続化 + RAG** | SpatialBridge が saveAnchor/loadAnchor | BE に anchor_id ↔ 作業メタデータを紐付け保存 (SQLite 拡張) | 前と同じ |

### 設計原則

- **責務**: Unity = 「空間と 3D の世界」、RN = 「業務ロジック・UI・LLM」
- **永続ライフサイクル**: Unity View は app root (`_layout.tsx`) で 1 個だけ mount し続ける (XREAL SDK 初期化が重いため再マウントしない)
- **後方互換**: Phase 1 のコードは Phase 2 以降でも壊れない。bridge API は method 名を足していくだけ
- **iOS/Web 非対応**: `UnityBridgeView` は Android 以外で null を返し、`useCameraCapture` は phone-back にフォールバック

### トレードオフ

| 項目 | 影響 |
|---|---|
| APK サイズ | **+50〜80MB** (Unity Runtime + XREAL SDK .aar) |
| ビルド時間 | +1〜2 分 (Unity → Android Library Export → Gradle flat-dir) |
| 開発環境 | **Unity 2023+ Editor が必要** (CI にも入れる必要あり) |
| IPC オーバーヘッド | postMessage は文字列のみ。JPEG はファイル経由 (`file://` URI) 推奨。10 秒間隔なら余裕 |
| Unity の二重ランタイム | メモリ使用増。Beam Pro (6GB RAM) なら許容範囲想定 |

### 初期立ち上げ手順

Unity プロジェクトの作成 / XREAL SDK import / C# スクリプト配置 / Android export の
具体的な操作手順は [`mobile/unity/README.md`](../mobile/unity/README.md) に集約。

`CameraBridge.cs` の **`// TODO(XREAL SDK)` 3 箇所** を埋めれば Phase 1 は完成する想定:

1. `Start()`: `NRSessionManager` 初期化 + `NRRGBCamTexture.Play()`
2. `CaptureCoroutine()`: `NRRGBCamTexture.Instance.GetTexture()` → Texture2D を取得
3. `OnDestroy()`: `NRRGBCamTexture.Stop()`

### 検証で詰まった場合の代替

1. **素の Camera2 API で XREAL Eye が拾えた場合**: 本経路を使わず `expo-camera` のレンズ切替で終了
2. **Unity 経路で初期化が不安定な場合**: Unity as a Library (UaaL) モードへ切替検討
3. **XREAL SDK の商用ライセンス問題**: コミュニティリポジトリ ([mpv-android-vr](https://github.com/mpv-android-vr/mpv-android-vr) / [Skarian/one-xr](https://github.com/Skarian/one-xr)) 由来の抽出 JAR 利用を検討

---

## 8. 検索品質評価

現在: 評価基盤なし

- Recall@k, MRR, NDCG
- 手動20件評価セット → Gemma で拡張 → RAGAS 統合
- クエリ変換 (HyDE, Multi-query)
