# XREAL × Unity × Expo (React Native) 統合ガイド

guidey で XREAL Beam Pro + XREAL 1S + Eye カメラを React Native (Expo) アプリから
使う際に遭遇した問題と解決策をまとめた実践ノート。

関連ファイル:

- [mobile/withUnityAndroid.js](../mobile/withUnityAndroid.js) — Expo config plugin (prebuild時の Android 配線)
- [mobile/modules/expo-unity-view/](../mobile/modules/expo-unity-view/) — 自前 Expo Native Module (Kotlin Wrapper)
- [mobile/lib/xreal/](../mobile/lib/xreal/) — JS 側ブリッジ (`bridge.ts` / `UnityBridgeView.tsx` / `camera.ts`)
- [mobile/unity/](../mobile/unity/) — Unity プロジェクト (guidey-unity) + export 成果物 (builds/android)
- [mobile/unity/README.md](../mobile/unity/README.md) — Unity側セットアップ手順

参考:

- [Zenn: Expo + UaaL for Android](https://zenn.dev/livetoon/articles/expo-uaal-android)
- [Qiita: XREAL Eye で Gemini API 連携](https://qiita.com/iwaken71/items/da5cc843b426390ff40e)
- [shogo0x2e/uaal-for-expo-example](https://github.com/shogo0x2e/uaal-for-expo-example)

---

## アーキテクチャ全体像

```
┌─ RN (Expo) ──────────────────────────────────────┐
│  guide / explore 画面                             │
│    └─ useCameraCapture()                          │
│        └─ captureXrealFrame()                     │
│            └─ unityBridge.send("Capture")         │
│                                                   │
│  app root に <ExpoUnityView/> を 1 つ常時マウント │
│    └─ expo-unity-view (自前 Expo Module)         │
│        └─ UnityManager (Kotlin singleton)         │
│            └─ UnityPlayerForActivityOrService     │
└───────────┬───────────────────────────────────────┘
            │ UnitySendMessage / emitMessage
┌───────────▼─ Unity (guidey-unity) ────────────────┐
│  SdkBridgeScene                                   │
│    └─ GameObject "CameraBridge"                   │
│        └─ CameraBridge.cs                         │
│            ├─ XREALPhotoCapture (Photo撮影)       │
│            └─ UnityInterop.SendToRN (応答返送)    │
│                                                   │
│  XREAL SDK 3.1.0 (Unity.XR.XREAL)                │
└───────────────────────────────────────────────────┘
```

---

## なぜ自前 Kotlin Wrapper が必要なのか

### 試して失敗したアプローチ

1. **`@azesmway/react-native-unity` v1.0.11**
   - Unity 6 非対応: `UnityPlayer` が `FrameLayout` を継承しなくなり
     `return unityPlayer` で型エラー
   - `node_modules` 内のパッチが必要 (pnpm install で消える)

2. **`@artmajeur/react-native-unity` (Unity 6 対応フォーク)**
   - コンパイルは通る
   - **RN 画面遷移で UnityPlayer が Pause/Resume を繰り返す**
   - Pause 中は `postMessage` が Unity に届かず **Capture がタイムアウト**
   - Unity View のサイズ (1×1 / 4×4 / フルスクリーン) を変えても改善せず

### 根本原因

既存の RN Unity ラッパーは **RN 画面の mount/unmount をそのまま Unity の
lifecycle に直結**させる。UaaL (Unity as a Library) としては設計上 NG で、
**Unity プロセス自体は singleton で保持し続けるべき**。

### 解決: shogo0x2e/uaal-for-expo-example 方式を移植

- `UnityPlayer` を **Singleton `UnityManager`** で保持
- `ExpoUnityView` の mount/unmount は**描画の attach/detach だけ**行う
- Activity は `onAttachedToWindow` 時に `UnityManager.resume()` を呼ぶだけ

実装: [mobile/modules/expo-unity-view/](../mobile/modules/expo-unity-view/)

---

## 踏んだ罠と対処 (時系列)

### 1. Android Build 環境

#### Java JDK
- `JAVA_HOME` が未設定 or repo ルートを指していると Gradle が死ぬ
- `asdf` 経由で Zulu 17 をグローバル設定: `asdf set --home java zulu-17.54.21`
- `~/.zshrc` の `. ~/.asdf/plugins/java/set-java-home.zsh` で自動 `JAVA_HOME`

#### Beam Pro の adb 認識
- USB-C には**映像出力専用ポート** (DP Alt Mode) と**データ通信ポート**がある
- 間違えると `ioreg` に `USB Type-C Digital AV Adapter` として見えて adb から不可視
- **別のUSB-Cポート**に挿し直すと adb device 列挙される

### 2. Android Gradle 統合 (`withUnityAndroid.js` で自動化)

Unity export された `unityLibrary` を RN プロジェクトに組み込む際のビルドエラー。

| エラー | 対処 |
|---|---|
| `Project with path ':unityLibrary:xrmanifest.androidlib' could not be found` | settings.gradle で XREAL SDK のサブモジュールも include |
| `Could not find :xreal-auto-log-1.2:` 等 | `allprojects.repositories` に flatDir 追加 (XREAL .aar 解決) |
| `UPlayer.java:100 UnityPlayer を FrameLayout に変換できません` | `@azesmway` の問題 → `@artmajeur` で解消、後に自前 module で置換 |
| `Could not get unknown property 'unity.androidNdkPath'` | gradle.properties に Unity Hub の NDK パスを設定 |
| `Manifest merger failed: enableOnBackInvokedCallback` | AndroidManifest の `<application>` に `tools:replace` 追加 |
| `minSdkVersion 24 cannot be smaller than 29` | `android.minSdkVersion=29` を gradle.properties で設定 |
| `Task ':app:mergeDebugJniLibFolders' uses this output of task ':unityLibrary:buildIl2Cpp' without declaring an explicit dependency` | app/build.gradle に `dependsOn(':unityLibrary:buildIl2Cpp')` 追加 |
| Beam Pro で guidey が XREAL の自動 Unity 画面として起動 | `NRXRActivity` の `MAIN+LAUNCHER` を `tools:node="remove"` で削除 |

すべて `withUnityAndroid.js` が prebuild 時に適用。Unity 再 export 後も
`npx expo prebuild -p android` で自動復元。

### 3. Unity Editor での XREAL 設定

`Project Settings > XREAL` で以下を正しく設定:

- **Initial Tracking Type = MODE_3DOF** ← XREAL 1S は 6DoF 非対応 (これを間違えると `NotFindRuntime`)
- **Support Devices** = `XREAL_DEVICE_CATEGORY_REALITY` を含む (default 済)

`Project Settings > XR Plug-in Management` で:

- **XREAL にチェック** ← XR セッション起動に必須。OFF だと PhotoCapture の
  BlendMode が強制的に `VirtualOnly` に変換され真っ黒画像になる

### 4. RN × Unity lifecycle 噛み合わせ問題 (本丸)

#### 症状

- 起動時に Unity が正しく初期化される
- 数秒後から `OnApplicationPause: True/False` が周期的に繰り返される
- 連発ログ: `NativeRendering FrameWait Failure`
- `postMessage` が Unity に届かず Capture タイムアウト

#### 何が起きていたか

1. `react-native-unity` 系ライブラリが Activity lifecycle を
   そのまま UnityPlayer に伝える
2. RN の画面遷移や Activity recreate (orientation など) で Unity Pause
3. XREAL SDK の `SessionManager` が `ActionCallback: 2026` を grasses destroy
   として処理 → session 破棄ループ

#### 対処: 自前 UnityManager で Singleton 化

`UnityManager.obtainPlayer` を lazy に 1 回だけ呼び、
`UnityPlayerForActivityOrService` を synchronized に保持。

`ExpoUnityView` は View 単位で `onAttachedToWindow` で resume、
`onDetachedFromWindow` で pause するだけ。**UnityPlayer 自体は破棄しない**。

### 5. XREALXRLoader の NullReferenceException

`@artmajeur` から自前 module に切り替えた後でも出続けたエラー:

```
NullReferenceException: Object reference not set to an instance of an object.
  at Unity.XR.XREAL.XREALXRLoader.Initialize ()
```

#### 原因

XREAL SDK は `XREALUtility.UnityActivity` から Activity を取得するが、
その実装は:

```csharp
// Library/PackageCache/com.xreal.xr@.../Runtime/Scripts/Utility/XREALUtility.cs:264
using AndroidJavaClass unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
s_UnityActivity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity");
```

通常の Unity アプリでは `UnityPlayerActivity.onCreate` が
`UnityPlayer.currentActivity = this` を自動でやる。
**UaaL 構成では誰もセットしない → null → NPE**。

#### 解決

`UnityManager.obtainPlayer` で `UnityPlayer` 作成**前後**に reflection で
`currentActivity` static フィールドを明示的にセット:

```kotlin
val field = UnityPlayer::class.java.getDeclaredField("currentActivity")
field.isAccessible = true
field.set(null, activity)
```

[mobile/modules/expo-unity-view/android/src/main/java/com/guidey/app/unityview/UnityManager.kt](../mobile/modules/expo-unity-view/android/src/main/java/com/guidey/app/unityview/UnityManager.kt) 参照。

### 6. 真っ黒画像問題

`XREALPhotoCapture` で撮影した画像が JPEG 15027B の**真っ黒画像**だった。

#### 原因

- `IsHMDFeatureSupported(RGB_CAMERA)` が false を返すと `AutoAdaptBlendMode` が
  `Blend` / `CameraOnly` を **強制的に `VirtualOnly` に変換**する
- `VirtualOnly` は Unity シーン内の 3D オブジェクトだけを撮影するモード
- Unity シーンは空なので真っ黒

#### 原因の原因

XR Loader が正しく初期化されていないと `IsHMDFeatureSupported` が常に false。
→ 解決策 5 (currentActivity reflection) で XR Loader 初期化成功
 → `IsHMDFeatureSupported(RGB_CAMERA)=true`
 → `AutoAdaptBlendMode : Blend => Blend` (変換されない)
 → 実写の撮影画像

### 7. Unity C# の反映遅延

C# ソースを書き換えたのに実機で古いコードが動く。

#### 原因

- Unity の Library/Bee に **il2cpp cache** がある
- Reimport だけでは差分なし判定で再コンパイルされないことがある

#### 対処

- `Assets > Refresh` で明示的に再スキャン
- キャッシュが疑わしいときは Unity Editor を完全終了 → 以下を削除:
  ```
  rm -rf mobile/unity/guidey-unity/Library
  rm -rf mobile/unity/guidey-unity/Temp
  rm -rf mobile/unity/builds/android
  ```
  → Unity 再起動で Library 再生成 → Build

### 8. Beam Pro スクリーンキャストモード

**Beam Pro + XREAL 1S グラスではスクリーンキャスト (2D mirror) モードで起動
しないとグラスに何も表示されない**。通常のアプリ起動だと「サードパーティアプリ
に侵入しています」と表示され真っ暗。

対処: XREAL Nebula ランチャー / Air Casting メニュー経由で起動する。

### 9. グラスに Unity 画面が流出する

XR Loader が正しく起動すると stereo display 権限をグラスに取りに行く。
Unity シーンに Main Camera が存在する限り、そのカメラ映像がグラスに描画され
Beam Pro のスクリーンキャスト (RN UI のミラー) を上書きしてしまう。

#### Phase 1 の対処: Main Camera を無効化

- Unity Editor で `SdkBridgeScene` の **Main Camera を無効化** (Inspector の
  チェックボックス OFF)
- Unity が何も描画しない → stereo buffer が空 → スクリーンキャスト (RN UI) が
  そのままグラスに見える
- XR Loader は有効のまま → `IsHMDFeatureSupported(RGB_CAMERA)=true` → 撮影可能

> 黒塗り (Clear Flags=Solid Color, Background=黒) は XREAL の加算合成で黒=透明の
> 扱いだが、合成モード切替タイミング等によって完全透明にならないことがあるので、
> 「描画を走らせない」= Camera 無効化 の方が確実。

#### Phase 2: カメラ復活 + 3D 描画

3D オブジェクトをグラスに重ねたいときは Main Camera を有効化し、
`Clear Flags = Solid Color` / `Background = 黒` に設定する。
XREAL の加算合成で背景は透過扱いになり、配置したオブジェクトだけが現実に浮かぶ。

- `UnityBridgeView` は 1×1 hidden のまま (RN 画面とは別レイヤーで表示されるため)
- hologramOpacity / BlendMode を動的に切り替えて撮影時だけ合成を変える、
  といった運用も可能

### 10. その他細かい罠

- **iOS orientation 固定問題**: `UISupportedInterfaceOrientations` を `app.json` の
  `ios.infoPlist` に明示 + `expo-screen-orientation` config plugin 登録
- **`@artmajeur` の minimum release age 制約**: pnpm のサプライチェーン対策で
  新しいバージョンが拒否される → `--config.minimumReleaseAgeExclude` で回避
- **vision-camera で XREAL Eye は取れない**: Android標準の Camera2 API からは
  Eye (Camera ID 2 相当) がpublic visible でない

---

## 動作確認手順

### 前提

- XREAL Beam Pro
- XREAL 1S + Eye (前面カメラ付き)
- Mac (macOS) + Unity 2023.2+ + JDK 17

### ビルド

```bash
# Unity で Build (C# 変更時のみ必須)
# File > Build Settings > Android > Build
# 出力先: mobile/unity/builds/android/

# RN 側
cd mobile
npx expo prebuild -p android
npx expo run:android
```

### アプリ操作

1. Beam Pro の Nebula ランチャー等でスクリーンキャストモード起動
2. guidey アプリを起動
3. Settings で **「XREAL 1S + Eye」プリセット**をタップ
4. explore モード or guide モードに入る
5. 音声 or periodic 撮影トリガで Eye 撮影

### 期待ログ (`adb logcat Unity:V CameraBridge:V UnityManager:V ReactNativeJS:V *:S`)

```
UnityManager: UnityPlayer.currentActivity set: before=null, after=com.guidey.app.MainActivity@...
Unity: [XREALXRLoader] Init
Unity: [XR] [NativeAPI] GetVersion: 3.1.1           ← 有効な値
Unity: Device Category: XREAL_DEVICE_CATEGORY_REALITY, type=XREAL_DEVICE_TYPE_XREAL_1S
Unity: [CameraBridge] Start() called
Unity: [CameraBridge] ready, resolution=1280x720
Unity: [CameraBridge] IsHMDFeatureSupported(RGB_CAMERA)=true
...
Unity: [CameraBridge] Capture() called
Unity: [CaptureContext] Create... blendMode=Blend  ← VirtualOnly ではない!
Unity: [CameraBridge] captured NNNNNB → /storage/.../xreal/frame-xxxx.jpg
ReactNativeJS: [Chat] first chunk NNNNms
```

BE ログで `image=yes` + ユーザー視界に基づく LLM 応答が来たら成功。

---

## Phase 2 (今後の拡張) メモ

- `SpatialBridge.cs` で `XRSession` から anchor/plane を取得
- `RenderBridge.cs` で 3D prefab を配置
- Unity View を 1×1 hidden から全画面に切り替え、RN UI を上に重ねる
- シースルー加算合成で現実世界への情報オーバーレイ

すでに確立した Kotlin Wrapper の API (`sendUnityMessage` / `addUnityMessageListener`)
はそのまま使える。Unity 側に新しい `GameObject` + スクリプトを追加するだけ。

---

## 関連ファイル index

### RN / Expo side
- [mobile/modules/expo-unity-view/android/src/main/java/com/guidey/app/unityview/UnityManager.kt](../mobile/modules/expo-unity-view/android/src/main/java/com/guidey/app/unityview/UnityManager.kt) — Singleton UnityPlayer + currentActivity reflection
- [mobile/modules/expo-unity-view/android/src/main/java/com/guidey/app/unityview/ExpoUnityView.kt](../mobile/modules/expo-unity-view/android/src/main/java/com/guidey/app/unityview/ExpoUnityView.kt) — View の attach/detach
- [mobile/modules/expo-unity-view/android/src/main/java/com/guidey/app/unityview/UnityToReactBridge.kt](../mobile/modules/expo-unity-view/android/src/main/java/com/guidey/app/unityview/UnityToReactBridge.kt) — Unity → RN メッセージ経路
- [mobile/lib/xreal/bridge.ts](../mobile/lib/xreal/bridge.ts) — request-response 相関 ID管理
- [mobile/lib/xreal/UnityBridgeView.tsx](../mobile/lib/xreal/UnityBridgeView.tsx) — app root で 1×1 hidden マウント
- [mobile/lib/xreal/camera.ts](../mobile/lib/xreal/camera.ts) — `captureXrealFrame()` public API
- [mobile/withUnityAndroid.js](../mobile/withUnityAndroid.js) — Android Gradle 配線の自動化

### Unity side
- [mobile/unity/guidey-unity/Assets/Scripts/CameraBridge.cs](../mobile/unity/guidey-unity/Assets/Scripts/CameraBridge.cs) — XREALPhotoCapture 実装
- [mobile/unity/guidey-unity/Assets/Scripts/UnityInterop.cs](../mobile/unity/guidey-unity/Assets/Scripts/UnityInterop.cs) — `UnityToReactBridge.emitMessage` 呼び出し

### Documentation
- [mobile/unity/README.md](../mobile/unity/README.md) — Unity Editor での初期セットアップ
