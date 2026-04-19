# スマートグラスモード (AR Mode) 実装計画

guidey に XREAL 1S + Beam Pro 向けの AR モードを追加するための段階的実装計画。

関連:
- [docs/xreal-unity-integration.md](docs/xreal-unity-integration.md) — これまでのハマりどころカタログ
- [mobile/unity/README.md](mobile/unity/README.md) — Unity Editor 作業手順
- [.claude/skills/unity-xreal-uaal/SKILL.md](.claude/skills/unity-xreal-uaal/SKILL.md) — Claude Code 用スキル

## 方針

**モード B (完全分離)** を採用する。

- Guide / Explore 等の既存モードは従来通り RN + phone-back カメラ
- XREAL AR は新規 route `/xreal-mode` で Unity 全画面に切り替え
- XREAL Eye カメラ (Phase 1 hidden capture) は当面諦める

### 根拠

- XR Loader 初期化を 1 回に限定 → `NotFindRuntime` 回避
- SurfaceView z-order 問題が消える (RN と共存しない)
- 戻るボタンを Unity 内 World Space Canvas に浮かせれば、コントローラ/音声で押せる
- ハイブリッド hidden mode の怪しい挙動も切り離せる

### アーキテクチャ図

```
┌─ RN シェル ────────────────────┐
│  Home / Settings / History      │
│  Guide / Explore (phone-back)   │
│  [AR モードに入る] ────────────┼──→ /xreal-mode route
└─────────────────────────────────┘                │
                                                   ▼
                        ┌─ Unity 全画面 (ARScene) ─┐
                        │  戻るボタン (浮遊)       │
                        │  チャットブロック         │
                        │  指示カード / アラート    │
                        │  画像・動画パネル         │
                        │  操作: 3DoF ポインタ/音声 │
                        └──────────────────────────┘
```

---

## Stage 別実装計画

各 stage 終了時に実機検証 → 次 stage に進む。

### Stage 0 — ARScene スケルトン (1h)

- `mobile/unity/guidey-unity/Assets/Scenes/ARScene.unity` 新規作成 (SdkBridgeScene とは別)
- `ARBootstrap.cs` を作って XR Origin + Main Camera を実行時構築
- Main Camera の ClearFlags = SolidColor / Background = (0,0,0,0)
  - XREAL は加算合成なので黒 = 透明
- Build Profiles に ARScene を登録 (最初のシーンを ARScene に)

**検証**: グラスで現実世界が透けて見える / 他に何も映らない

### Stage 1 — 浮遊 Cube (30m)

- ARBootstrap で 2m 前方に回転する Cube を Instantiate
- `Update()` で Y 軸回転、`Material` は URP デフォルト

**検証**:
- グラスに立体で見える
- 頭を動かすと奥行き感が正しい (3DoF トラッキング動作)
- Unity 描画経路が生きている

### Stage 2 — World Space Canvas + 戻るボタン (2h)

- `Canvas` (RenderMode=WorldSpace) + `CanvasScaler` を Main Camera の子に配置 (head-locked)
- **Back Button**:
  - 左上の固定位置 (画面座標で -30°, +20° 付近)
  - アイコン (` ← ` の TMP または PNG)
  - `BackButton.cs` で `OnClick` → `NavigateBridge.RequestBack()` (Stage 3 で配線)
- **日本語 TMP Font Asset 生成** (Noto Sans JP, Unicode Range: `3040-309F,30A0-30FF,4E00-9FAF,FF00-FFEF`)
  - 一度作れば `.asset` は text (YAML) で Git 管理可

**検証**:
- Canvas の UI がグラスに見える
- 日本語「戻る」が豆腐にならない
- head-lock で UI が視界に追随する

### Stage 3 — RN 遷移 + 戻るボタン配線 (2h)

- `mobile/app/xreal-mode.tsx` 新規 route:
  ```tsx
  export default function XrealMode() {
    const router = useRouter();
    useEffect(() => {
      const unsub = unityBridge.onEvent("navigate", (e) => {
        if (e.action === "back") router.back();
      });
      return unsub;
    }, []);
    return <UnityBridgeView visible />;
  }
  ```
- `mobile/lib/xreal/bridge.ts` に汎用 event listener (`onEvent(kind, handler)`) を追加
  - 今の request-response とは別経路で "Unity 発 RN イベント" を流す
- Unity 側 `NavigateBridge.cs`: `UnityInterop.SendToRN(...)` で `{ kind: "navigate", data: { action: "back" } }` 送信
- 音声「戻る」トリガも追加 (RN 側 speech recognition hook で同じ `router.back()`)

**検証**:
- コントローラで戻るボタン押す → RN ホームに戻る
- 音声「戻る」でも戻る
- Unity singleton は生きたまま (戻って再突入しても初期化走らない)

### Stage 4 — RenderBridge で RN ブロック描画 (3h)

- `RenderBridge.cs`: RN から `ShowBlocks(blocks[])` を受けて Canvas 下に動的生成
- ブロック種別ごとに Prefab (Bootstrap.cs から実行時生成):
  - `TextBlock` — チャットメッセージ / 指示文
  - `ImageBlock` — 画像 + キャプション
  - `AlertBlock` — 警告 (赤枠 + アイコン)
  - `InstructionCard` — 現在の手順カード
- RN 側 `mobile/lib/xreal/render.ts` の `showBlocksOnGlasses(blocks)` を実装
- guidey の periodic loop / chat 応答から流れる activeBlocks を `SmartGlassesLayout` 経由で bridge に流す

**検証**:
- periodic loop のブロックがグラスに即時反映
- 画像が WebRequest で取得されて表示される

### Stage 5 — SF っぽい AR 演出 (2h, best-effort)

- **配置**: 右側に半円状にカーブ配置 (平面ではなく弧)
  - ゾーニング: 指示カード=中央 / アラート=上部 / 画像=右下 / チャット=左サイド
  - 深度を 1.8〜2.5m でバラす → レイヤー感
- **マテリアル**: ガラス風 (Transparent + Emission 薄く) で "板" 感
- **アニメ**: ブロック追加/削除時のフェード+スライド (DOTween or coroutine)
- **Back Button のホバーエフェクト**: ポインタ当たったら微発光

---

## 操作系

| 操作 | 実装 | 優先度 |
|---|---|---|
| **3DoF コントローラポインタ** | `NRPointerRaycaster` + `UI/GraphicRaycaster`。[boichi 本 8章](https://zenn.dev/boichi/books/d4410dd7c018c7/viewer/8e869c) 参照 | 高 |
| **音声「戻る」「次」等** | 既存 `expo-speech-recognition` → RN 側で intent 判定 → bridge 送信 | 高 |
| **gaze + dwell クリック** | Stage 5 以降。コントローラなし時の fallback | 低 |
| **スマホ画面タップ** | 全画面 Unity なので基本使わない。dev ビルドだけ screen tap で Back 発火の保険 | 中 |

---

## ファイル構成 (予定)

```
mobile/unity/guidey-unity/Assets/Scenes/
├── SdkBridgeScene.unity         ← 既存 (当面残す)
└── ARScene.unity                ← 新規

mobile/unity/guidey-unity/Assets/Scripts/
├── ARBootstrap.cs               ← 新規 (シーン全構築)
├── BackButton.cs                ← 新規
├── NavigateBridge.cs            ← 新規 (Unity→RN ナビ)
├── RenderBridge.cs              ← 新規 (RN→Unity ブロック)
├── CameraBridge.cs              ← 既存
└── UnityInterop.cs              ← 既存

mobile/unity/Assets/Scripts/      ← git 管理下の復旧ソース (同期)
├── ARBootstrap.cs
├── BackButton.cs
├── NavigateBridge.cs
├── RenderBridge.cs
├── CameraBridge.cs
└── UnityInterop.cs

mobile/app/
└── xreal-mode.tsx               ← 新規 route

mobile/lib/xreal/
├── bridge.ts                    ← onEvent() 汎用 listener 追加
├── navigate.ts                  ← 新規 (NavigateBack 発火経路)
└── render.ts                    ← 新規 (showBlocksOnGlasses)
```

---

## リスク管理

| リスク | 緩和策 |
|---|---|
| XR Loader が今の端末で不安定 (`NotFindRuntime`) | Stage 0 で即検証。ダメなら Beam Pro 再起動 → アプリ再インストール → OS 更新確認 |
| Japanese TMP Font Asset 生成が Editor 必須 | 一度作れば `.asset` は YAML で Git 管理可 |
| コントローラ入力の XR SDK API がバージョン間で変わってる | boichi 本は 3.0 系。現在 3.1。API 差分は Stage 3 時点で確認 |
| 戻るボタンに触れないバグ | dev ビルドで `adb shell am broadcast` で強制 back を送れる保険コマンドを用意 |
| Unity 側から RN の state が取れない | bridge は一方向 request-response + 別 channel の event。必要なら RN → Unity で state snapshot を送る |

---

## 推奨初手

**今夜は Stage 0 だけ** やって「グラスに何も映らず現実が透ける」成功体験を取るのが最効率。
ここが通れば残りは積み上げ。

## 工数見積

| Stage | 想定時間 |
|---|---|
| 0. Skeleton | 1h |
| 1. Floating Cube | 30m |
| 2. Canvas + Back Button | 2h |
| 3. RN navigation wiring | 2h |
| 4. RenderBridge + blocks | 3h |
| 5. SF polish | 2h |
| **合計** | **~10.5h** |

セッション 3-4 回分。LT 発表前に完了可能。

---

## 完了基準

- [ ] Stage 0-3 完了: グラスで戻るボタンをコントローラで押せて RN に戻れる
- [ ] Stage 4 完了: periodic loop のブロックがグラスに流れる
- [ ] Stage 5 完了: "SF っぽい" と言える見た目の AR UI
- [ ] 動画キャプチャ (Beam Pro のスクリーンレコード + スマホカメラでグラス越し撮影) → LT スライドに貼る
