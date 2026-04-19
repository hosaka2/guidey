# guidey Unity 開発ガイド

Unity Editor での日常開発の手順と、よくハマる箇所をまとめる。
初回セットアップは [README.md](README.md)、RN 統合全体の設計は [../../docs/xreal-unity-integration.md](../../docs/xreal-unity-integration.md)。

## 前提

- Unity 6 (6000.4.3f1)
- `mobile/unity/guidey-unity/` が Unity プロジェクト本体 (git 管理外)
- `mobile/unity/Assets/Scripts/` に `.cs` のソース複製 (git 管理)
- `mobile/unity/builds/android/` に Export 先 (git 管理外)
- 実機: Beam Pro (XREAL X4100) + XREAL 1S

## 変更→反映の基本フロー

### ケース A: C# スクリプトだけ変更

```
1. mobile/unity/Assets/Scripts/*.cs を編集
2. mobile/unity/guidey-unity/Assets/Scripts/ にコピー
   cp mobile/unity/Assets/Scripts/*.cs mobile/unity/guidey-unity/Assets/Scripts/
3. Unity Editor に戻ると自動で再コンパイル
4. File > Build Profiles > Android > Build (Export)
5. cd mobile && npx expo run:android
```

**Assets/Scripts を単一ソースにしているのは**、Unity プロジェクト本体を git 管理外にしているため。
シンボリックリンクも検討したが、Unity の meta 管理と衝突するのでコピー運用が無難。

### ケース B: Scene / Prefab / Inspector 値だけ変更

```
1. Unity Editor で編集
2. Cmd+S で保存
3. Export → npx expo run:android
```

### ケース C: 新規 Prefab / Scene を追加

Unity プロジェクト本体 (`guidey-unity/`) は git 管理外。
新規アセットは永続化の対象外になるため、以下どちらかで対応:

- **コード化**: Prefab 構成を C# の `[SerializeField]` + `FindObjectOfType` + `Instantiate` で生成、`.cs` は git 管理
- **Export 前に一旦コミット**: `guidey-unity/Assets/` の必要部分だけ選択的に git add (推奨しない、meta ファイルが多く煩雑)

現状は Prefab を使う以上 **Unity プロジェクト本体を失うと復旧時に Prefab 作り直し** になる。
重要な Prefab の構成は [README.md](README.md) の Phase 2 セクションに手順書として残す。

### ケース D: RN 側だけ変更 (Unity コードも Scene も触らない)

Unity 再 Export 不要。

```
cd mobile && npx expo run:android
```

## コンポーネント構成

### Scene: SdkBridgeScene

```
SdkBridgeScene
├── Main Camera           // XR Loader が stereo 化
├── Directional Light
├── CameraBridge          // Phase 1: XREAL Eye 撮影
├── Canvas                // Phase 2: 空間 UI (World Space)
│   ├── TextContainer     //   VerticalLayoutGroup、左半分
│   └── MediaContainer    //   VerticalLayoutGroup、右半分
├── EventSystem           // (UI イベント用、現状は未使用)
└── RenderBridge          // Phase 2: RN からの ShowBlocks 受信
```

### Script ↔ GameObject 対応

| Script | アタッチ先 | 役割 |
|---|---|---|
| [CameraBridge.cs](Assets/Scripts/CameraBridge.cs) | `CameraBridge` | XREAL Eye 撮影 (PhotoCapture) |
| [RenderBridge.cs](Assets/Scripts/RenderBridge.cs) | `RenderBridge` | RN からの Block を Canvas に描画 |
| [UnityInterop.cs](Assets/Scripts/UnityInterop.cs) | static | Unity → RN 送信ユーティリティ |

### RN 側の対応

| ファイル | 役割 |
|---|---|
| [mobile/lib/xreal/bridge.ts](../lib/xreal/bridge.ts) | request-response (correlation ID) |
| [mobile/lib/xreal/camera.ts](../lib/xreal/camera.ts) | `CameraBridge.Capture` 呼び出し |
| [mobile/lib/xreal/render.ts](../lib/xreal/render.ts) | `RenderBridge.ShowBlocks` 呼び出し |
| [mobile/lib/xreal/UnityBridgeView.tsx](../lib/xreal/UnityBridgeView.tsx) | Unity View ホスト (hidden/fullscreen) |
| [mobile/modules/expo-unity-view/](../modules/expo-unity-view/) | Kotlin wrapper + Expo Module 定義 |

## bridge メッセージ仕様

双方向 JSON。Unity 側は `JsonUtility.FromJson<T>` でパースするため、ネスト JSON は文字列としてもフィールドに入る前提の素直な構造にする (`[Serializable]` class を使う)。

### RN → Unity

```json
{ "id": "uuid", "method": "ShowBlocks", "args": { "blocks": [...] } }
```

### Unity → RN

```json
{ "id": "uuid", "kind": "render", "data": "{\"ok\":true}", "error": null }
```

`data` は JSON 文字列 (JsonUtility の制約で object 直置き不可)。RN 側の [bridge.ts](../lib/xreal/bridge.ts) が `JSON.parse` で復元する。

### 新しいメソッドを追加する手順

1. Unity 側:
   - `RenderBridge.cs` に `public void MyMethod(string json)` を追加
   - `[Serializable] private class MyArgs { ... }` を定義
   - `TryParse(json)` で request 取得、処理後 `Reply(req.id, JsonUtility.ToJson(data), null)` で応答
2. RN 側:
   - `mobile/lib/xreal/render.ts` に wrapper を追加
   - `unityBridge.send({ gameObject: "RenderBridge", method: "MyMethod", args: {...} })`
3. コピー + Export + `npx expo run:android`

## デバッグ

### logcat フィルタ

```bash
# 全体 (RN JS + Unity + ExpoUnityView)
adb logcat ReactNativeJS:V Unity:V ExpoUnityView:V UnityManager:V *:S

# RenderBridge / CameraBridge に絞る
adb logcat Unity:V RenderBridge:V CameraBridge:V *:S | grep -E "RenderBridge|CameraBridge"

# XR Loader の起動成否を確認
adb logcat Unity:V *:S | grep -iE "XRLoader|NRMetrics|NotFindRuntime|IsHMDFeatureSupported"
```

### 成功時に出るべきログ

```
[XREALXRLoader] Init End
[XREALXRLoader] Start End
Device Category: XREAL_DEVICE_CATEGORY_REALITY, type=XREAL_DEVICE_TYPE_XREAL_1S
[CameraBridge] IsHMDFeatureSupported(RGB_CAMERA)=True, resolution=1280x720
[XR] [NRMetrics] FramePresent: 1, ..., DroppedFrame: 0, ...
[RenderBridge] ShowBlocks payload=NNNB
```

### 失敗時の症状と対策

| 症状 | 原因 | 対策 |
|---|---|---|
| `NotFindRuntime` | XREAL ランタイム初期化失敗 | グラス挿し直し、`adb uninstall com.guidey.app` して再インストール |
| `NRMetrics: FramePresent: 0` | ステレオ描画未起動 | Main Camera の Priority が負 → 0 に、Culling Mask = Everything 確認 |
| `IsHMDFeatureSupported(RGB_CAMERA)=False` | XR Loader 起動失敗の結果として RGB カメラも取れない | XR Loader 起動を直す |
| `ShowBlocks` が来ない | RN 側で bridge が起動していない / smart-glasses モードでない | Settings で `smart-glasses` を選ぶ、`adb logcat ReactNativeJS` で `[xreal/render]` 出力確認 |
| ブロックは来るがグラスに何も映らない | Unity View が 1×1 のまま / Main Camera 設定不備 | UnityBridgeView の visible=true になっているか、Main Camera の Priority, Clear Flags, Culling Mask 確認 |
| スマホ画面も真っ暗 | smart-glasses モードで Unity 全画面 | 仕様。ホーム画面では hidden に戻るように `_layout.tsx` で `useSegments` で制御済み |

### Unity Editor 側の Console 確認

Play モード (Editor 内で ▶) でも CameraBridge は editor mock で動作するので、基本的な通信フローは Editor でも試せる (XREAL SDK 依存部分は `#if UNITY_ANDROID && !UNITY_EDITOR` で除外)。
RenderBridge も Editor で `ShowBlocks` を直接呼べば Canvas に Prefab が並ぶ (XR Loader は動かないので Scene ビューで確認)。

## ハマりどころ集 (Phase 2)

### Unity のコードが反映されない

- `Assets/Scripts/` に置いても **`guidey-unity/Assets/Scripts/` にコピーしていない** と Unity は見えない
- IL2CPP ビルドキャッシュが効いてる場合は `guidey-unity/Library/Bee/` を削除して再 Import

### Scene の保存忘れ

- タイトルバーに `*` が付いていたら未保存
- Prefab 化しても Scene に未保存ならリフレクション参照が消える
- **Cmd+S を習慣化**

### Prefab 作成時の親

- Canvas **の外** で `Create Empty` すると RectTransform にならず UI として破綻
- 必ず Canvas (か Canvas の子) の下で作って、Prefab 化してから Hierarchy のインスタンスを削除

### Anchor Preset が反応しない

- Inspector のモードが Debug になっていると数値直編集のみ
- Normal モードで `Anchor Preset` ボタンが出る
- 効かない場合は直接数値入力で代替 (Anchors Min/Max で指定)

### World Space Canvas の Scale

- デフォルト `Scale = 1` だと 1 unit = 1m で馬鹿でかい
- `0.0015` 前後が標準 (1px ≒ 1.5mm)
- カメラ前方 2m 前後の `Pos Z` と合わせて調整

### UGUI の Content Size Fitter

- 見つからない時は `fitter` で検索
- 無くても VerticalLayoutGroup だけで並ぶ (固定高さの Container 前提)

### XR Loader が Target Eye の指定を無視する

- World Space Canvas の Event Camera 未設定警告は無視して OK
- XR Loader が Main Camera の Projection を両目別に置き換える
- Target Eye = Both のまま (None にすると非表示)

### UnityPlayer の singleton 解除で無限 pause/resume

- `UnityManager.kt` で `UnityPlayerForActivityOrService` を singleton 保持
- ExpoUnityView の `onAttachedToWindow` / `onDetachedFromWindow` で resume/pause するだけ
- 新しい Activity を開くときは `UnityPlayer.currentActivity` を reflection で差し替える (XR Loader が NPE を吐くのを防ぐ)

## 新規 bridge メソッド追加のチェックリスト

Phase 2 を拡張する時の手順を再掲:

- [ ] `RenderBridge.cs` (or 新 Script) にメソッド追加
- [ ] `[Serializable]` payload class 定義
- [ ] Unity Editor で GameObject に Script アタッチ (既存 RenderBridge なら不要)
- [ ] `mobile/unity/Assets/Scripts/` と `guidey-unity/Assets/Scripts/` 両方に反映
- [ ] RN 側に wrapper 関数を追加
- [ ] 呼び出し元 (layout / hook) から使用
- [ ] Cmd+S, Export, `npx expo run:android`
- [ ] logcat で疎通確認

## Phase 2 以降の拡張候補

- **body-lock UI**: Canvas を Main Camera の子にする or `LateUpdate` でカメラ位置に追従
- **Curved Canvas**: `Mesh` ベースで円筒状に曲げる
- **DOTween**: メッセージ出現アニメ (fade/slide)
- **Shader Graph**: 背景ガラスパネルのノイズシェーダー
- **VFX Graph**: 新着メッセージ粒子エフェクト
- **SpatialBridge.cs**: `XRSession` から anchor / plane 取得、実空間に UI ピン留め
- **Voice feedback アニメ**: assistant 応答中の 3 dot loader

## 参考

- [README.md](README.md) — 初回セットアップ手順
- [../../docs/xreal-unity-integration.md](../../docs/xreal-unity-integration.md) — RN 統合設計
- [XREAL SDK for Unity docs](https://docs.xreal.com/)
- [Unity 6 docs](https://docs.unity3d.com/6000.0/Documentation/Manual/index.html)
