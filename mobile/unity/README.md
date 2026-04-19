# guidey Unity Adapter

RN アプリ (guidey) の **SDK アダプタ層** として動く最小 Unity プロジェクト。
カメラ取得 → (将来) 空間アンカー / 3D 描画へ段階的拡張。

> 統合の設計・ハマりどころ・Android Gradle 連携の詳細は
> [`docs/xreal-unity-integration.md`](../../docs/xreal-unity-integration.md) にまとまっている。
> ここは **Unity Editor での作業手順** だけ。

## ディレクトリ構成

```
mobile/unity/
├── Assets/Scripts/      ← git 管理下 (復旧ソース)
│   ├── CameraBridge.cs
│   └── UnityInterop.cs
├── guidey-unity/        ← Unity プロジェクト本体 (git 管理外)
│   └── Assets/Scripts/  ← Unity が実際に読むほう。Assets/Scripts/ からコピーする
└── builds/android/      ← Unity から Export した Android プロジェクト (gradle で参照)
```

Unity プロジェクトを失っても `Assets/Scripts/` + この手順書から復旧できる。

## 初期セットアップ (Beam Pro / XREAL 1S)

### 1. プロジェクト作成
1. Unity Hub で **New project**
2. テンプレート: **3D (URP)** または **3D Core**
3. Project name: `guidey-unity` → `mobile/unity/guidey-unity` に作成

### 2. XREAL SDK インポート
> ⚠️ tar.gz を直接 `Assets` にドラッグしない (エラーになる)

1. **Window > Package Manager** → 左上 `+` → **Add package from tarball...**
2. `XREAL SDK for Unity 3.x.tar.gz` を選択
   (Mac で自動解凍済みなら `Add package from disk...` → `package/package.json`)

### 3. XR プラグイン有効化
**Edit > Project Settings > XR Plug-in Management** → Android タブで **XREAL** にチェック。

### 4. XREAL 設定
**Project Settings > XREAL**:
- **Initial Tracking Type = MODE_3DOF** (XREAL 1S は 6DoF 非対応)

### 5. Android ビルド設定
1. **File > Build Profiles** → Platform = **Android** / Texture Compression = **ASTC**
2. **Project Settings > Player > Android > Other Settings**:
   - Auto Graphics API オフ → `OpenGLES3` のみ (Vulkan 削除)
   - Scripting Backend = **IL2CPP**
   - Target Architectures = **ARM64** のみ

### 6. シーン作成
1. `Assets/Scripts/` フォルダ作成 → [mobile/unity/Assets/Scripts/](Assets/Scripts/) の `.cs` をコピー
2. 新規 Scene 作成 → `SdkBridgeScene` にリネーム
3. Hierarchy で空 GameObject → **`CameraBridge`** (名前完全一致必須) → `CameraBridge.cs` を Add Component
4. **Build Profiles** に `Add Open Scenes` で登録

### 7. RN 側へ Export
**File > Build Profiles > Android** → **Export Project** にチェック → Build
→ 出力先: `mobile/unity/builds/android`

### 8. Android Gradle 統合 (自動)
[`mobile/withUnityAndroid.js`](../withUnityAndroid.js) が `npx expo prebuild -p android` 時に
`settings.gradle` / `build.gradle` / `AndroidManifest.xml` 等に必要な配線を自動注入する。
Unity 再 Export した場合も `prebuild` 再実行で OK。

## iOS

iOS では Unity / XREAL は無効。`expo-unity-view` モジュールが iOS では no-op、
`react-native.config.js` で autolinking も無効化済み。**iOS ビルドはそのまま通る**。

## 動作確認

1. `cd mobile && npx expo prebuild -p android && npx expo run:android`
2. Beam Pro を Nebula のスクリーンキャストモードで起動
3. guidey の Settings でプリセット **「XREAL 1S + Eye」**
4. guide / explore で periodic 撮影トリガ → Eye 経由でフレーム取得

## bridge メッセージ仕様

JSON 文字列で双方向通信。相関 ID で request-response 紐づけ。

### RN → Unity (`sendUnityMessage`)
```json
{ "id": "uuid", "method": "Capture", "args": {} }
```

### Unity → RN (`UnityInterop.SendToRN`)
```json
{ "id": "uuid", "data": { "uri": "file:///..." } }
{ "id": "uuid", "error": "camera not ready" }
```

型定義: [mobile/lib/xreal/types.ts](../lib/xreal/types.ts)

## Phase 2: 空間 UI (RenderBridge)

RN の activeBlocks を Unity の World Space Canvas に描画し、グラスに「空中の箱」として浮かべる。

### Unity 側セットアップ

1. **XR Origin 配置**
   - Hierarchy に `XR Origin (VR)` prefab か空 GameObject を置く
   - 子に Main Camera (Tag = MainCamera)

2. **World Space Canvas 作成**
   - Hierarchy > UI > Canvas → Render Mode = **World Space**
   - RectTransform: Width/Height = 1600 x 1000 (px), Scale = 0.0015 前後
   - Position = (0, 0, 2) (カメラ前方 2m)
   - Canvas 下に空 GameObject を 2 つ:
     - `TextContainer` (RectTransform 左半分) + **Vertical Layout Group** + Content Size Fitter
     - `MediaContainer` (RectTransform 右半分) + **Vertical Layout Group**

3. **Prefab を 2 つ作成** (`Assets/Prefabs/` 配下推奨)
   - `TextBlockPrefab`
     - root に `LayoutElement` (Preferred Height = 80)
     - 子に `TextMeshProUGUI` (Font Size = 48, Auto Size off)
   - `ImageBlockPrefab`
     - root に `LayoutElement` (Preferred Height = 400)
     - 子に `RawImage` (上 80% の領域) と `TextMeshProUGUI` (下 20%、キャプション)

4. **`RenderBridge` GameObject**
   - Canvas の隣 (Canvas の子ではない) に空 GameObject、名前 `RenderBridge` (RN 側 `gameObject: "RenderBridge"` と一致必須)
   - [`Assets/Scripts/RenderBridge.cs`](Assets/Scripts/RenderBridge.cs) を Add Component
   - Inspector で:
     - `Text Container` ← 上で作った TextContainer
     - `Media Container` ← MediaContainer
     - `Text Block Prefab` ← TextBlockPrefab
     - `Image Block Prefab` ← ImageBlockPrefab

5. **Main Camera 設定**
   - Clear Flags = **Solid Color**, Background = **Black (0,0,0,0)**
     XREAL グラスは加算合成なので黒 = 透明 (実世界が透ける)

6. **Build & Export** → `npx expo prebuild -p android && npx expo run:android`

### RN 側の仕組み

[`mobile/lib/xreal/render.ts`](../lib/xreal/render.ts) の `showBlocksOnGlasses(blocks)` が
`unityBridge.send({ gameObject: "RenderBridge", method: "ShowBlocks", args: { blocks } })` を発行。

[`mobile/components/layout/SmartGlassesLayout.tsx`](../components/layout/SmartGlassesLayout.tsx)
の useEffect で activeBlocks の変化をそのまま Unity に流し込む。
画面 unmount 時に `clearBlocksOnGlasses()` で空にする。

### 既知の制限 / TODO

- 3DoF のみ追従 (1S は 6DoF 非対応)。body-lock で頭の回転に追従、位置は固定
- 画像は URL または file:// 経由で `UnityWebRequestTexture` で取得 (認証付きは要対応)
- timer ブロックはカウントダウン UI 未対応 (現状は "label Ns" と表示のみ)

### さらに先の拡張

- `SpatialBridge.cs`: `XRSession` から anchor / plane 取得、実空間にピン留め
- `DrawArrow { anchor_id, pose, text }` で 3D prefab instantiate
- Unity View を 1×1 hidden → 全画面に切替 (`cameraSource === "xreal-eye-3d"` 等)
