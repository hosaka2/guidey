---
name: unity-xreal-uaal
description: Build Unity + XREAL AR features embedded in React Native (Expo) apps using the Unity-as-a-Library (UaaL) pattern. Use when the user works on guidey's Unity integration (mobile/unity/, mobile/modules/expo-unity-view/, mobile/lib/xreal/), adds new Unity GameObjects/bridges (CameraBridge/RenderBridge/etc.), debugs XREAL SDK issues on Beam Pro, or extends the Phase 2 World Space Canvas UI. Covers the Editor-minimal "Bootstrap.cs" workflow, CLI build automation, and the traps documented in docs/xreal-unity-integration.md.
---

# Unity × XREAL × Expo UaaL ガイド

guidey 固有の Unity 統合スキル。RN (Expo) に Unity 6 + XREAL SDK を組み込むためのパターン集。

**前提知識の置き場**:
- [docs/xreal-unity-integration.md](../../../docs/xreal-unity-integration.md) — ハマりどころ全カタログ (必読)
- [mobile/unity/README.md](../../../mobile/unity/README.md) — Unity Editor 作業手順
- [mobile/withUnityAndroid.js](../../../mobile/withUnityAndroid.js) 冒頭コメント — Gradle 配線の背景

## 重要原則

### 1. Editor 作業は最小化、コード優先

Unity Editor は以下 3 点でしか開かない:
- 初回セットアップ (XREAL SDK tar.gz インポート等)
- `XREALSettings.asset` / `Player Settings` の GUI 設定
- 必要時のみ `Export Project` (CLI 化可能、下記参照)

**シーン・Prefab・UI は全て `Bootstrap.cs` で実行時に構築**。`.unity` ファイルは GameObject 1 個のスタブだけにする。

### 2. UnityPlayer は singleton、lifecycle 直結 NG

`UnityManager.kt` (singleton) が `UnityPlayerForActivityOrService` を保持。
RN の View mount/unmount では Unity プロセス破棄しない。直結すると Pause/Resume 無限ループに落ちる。

### 3. XREAL SDK は `UnityPlayer.currentActivity` static を reflection で書く

UaaL 構成では誰もセットしないため NPE。`UnityManager.kt` の `setCurrentActivityReflectively` を**コンストラクタ前後で 2 回呼ぶ**こと (コンストラクタでリセットされる可能性)。

### 4. hidden mode の外側 View wrap は必須

`UnityBridgeView` で `<ExpoUnityView style={styles.hidden}>` を直接返すと XR Loader が stereo display を掴む。必ず外側 `<View style={hidden}>` で包む:

```tsx
<View style={styles.hidden} pointerEvents="none">
  <ExpoUnityView style={StyleSheet.absoluteFill} />
</View>
```

SurfaceView の measurement タイミングを 1 tick ずらすと grab が抑制される (Android ネイティブ層依存、端末差あり)。

### 5. BlendMode.VirtualOnly は silent failure の罠

`IsHMDFeatureSupported(RGB_CAMERA)=false` だと `AutoAdaptBlendMode` が勝手に `Blend` → `VirtualOnly` に変換、Unity シーンを撮影して "真っ黒画像" を返す。LLM が幻覚応答を返す原因。

**防御コード**: `CameraBridge.cs` で `autoAdaptBlendMode = false` にし、`VirtualOnly` 検出時はエラー返却。

## アーキテクチャ 2 択

### モード A: ハイブリッド (1×1 hidden)
- `UnityBridgeView` を root に常時マウント (1×1 opacity:0)
- Unity は camera capture 専用で裏で動く
- RN UI 全面。スマホ画面が主
- **問題**: XR Loader が環境依存で失敗することがある (`NotFindRuntime`)

### モード B: 完全分離 (推奨)
- `/xreal-mode` route に遷移した時だけ Unity を mount (fullscreen)
- Unity 全画面 + 音声操作のみ。RN UI なし
- XR Loader 初期化が一発勝負で安定
- 戻るボタンで RN に復帰 (Unity は singleton で生きたまま)

新規機能は **モード B** で設計することを推奨。

## コーディングパターン

### Bootstrap.cs (シーン構築の中心)

```csharp
public class Bootstrap : MonoBehaviour {
  void Start() {
    BuildXROrigin();
    BuildWorldCanvas();
    BuildBridges();
  }

  void BuildWorldCanvas() {
    var go = new GameObject("Canvas");
    var canvas = go.AddComponent<Canvas>();
    canvas.renderMode = RenderMode.WorldSpace;
    go.transform.position = new Vector3(0, 0, 2);
    go.transform.localScale = Vector3.one * 0.0015f;
    go.AddComponent<CanvasScaler>();
    go.AddComponent<GraphicRaycaster>();
    // TextContainer / MediaContainer を子に追加...
  }

  void BuildBridges() {
    new GameObject("CameraBridge").AddComponent<CameraBridge>();
    new GameObject("RenderBridge").AddComponent<RenderBridge>();
  }
}
```

シーン `.unity` は空の GameObject に `Bootstrap` コンポーネントを 1 つ付けるだけ。

### RN ↔ Unity メッセージ規約

双方向 JSON with 相関 ID:

```ts
// RN → Unity
await unityBridge.send({
  gameObject: "CameraBridge",
  method: "Capture",
  args: {},
  timeoutMs: 3000,
});

// Unity → RN (CameraBridge.cs 内)
UnityInterop.SendToRN(JsonUtility.ToJson(new Response {
  id = request.id,
  kind = "camera",
  data = JsonUtility.ToJson(new { uri = path }),
}));
```

型は [mobile/lib/xreal/types.ts](../../../mobile/lib/xreal/types.ts) と Unity 側の matching 構造体で合わせる。

### CLI ビルド (Editor 開かずに APK 作る)

```makefile
# mobile/Makefile 等
unity-export:
	/Applications/Unity/Hub/Editor/6000.x/Unity.app/Contents/MacOS/Unity \
	  -batchmode -nographics -quit \
	  -projectPath mobile/unity/guidey-unity \
	  -executeMethod Builder.ExportAndroid \
	  -logFile -
```

```csharp
// Assets/Editor/Builder.cs
public static class Builder {
  public static void ExportAndroid() {
    EditorUserBuildSettings.exportAsGoogleAndroidProject = true;
    BuildPipeline.BuildPlayer(new BuildPlayerOptions {
      scenes = new[] { "Assets/Scenes/Main.unity" },
      locationPathName = "../builds/android",
      target = BuildTarget.Android,
    });
  }
}
```

`make unity-export && npx expo prebuild -p android && npx expo run:android` が 1 コマンド化できる。

## 日本語対応

TMP デフォルトの `LiberationSans SDF` は ASCII のみ。Noto Sans JP + 日本語 Unicode Range を含む **TMP Font Asset** を生成して Prefab に差し替える。

Unicode Range (最低限):
```
3040-309F, 30A0-30FF, 4E00-9FAF, FF00-FFEF
```

生成は Editor 作業だが 1 回だけ。Asset ファイル (`.asset`) 自体は YAML text なので Git 管理可。

## 公式ドキュメント / 参考

- [XREAL Developer Docs](https://developer.xreal.com/)
- [Zenn: Expo + UaaL for Android](https://zenn.dev/livetoon/articles/expo-uaal-android)
- [shogo0x2e/uaal-for-expo-example](https://github.com/shogo0x2e/uaal-for-expo-example) — このプロジェクトの下敷き
- [gree/unity-webview](https://github.com/gree/unity-webview) — HTML/JS を World Space Canvas に貼る場合

## 新機能追加のデフォルト手順

1. **Unity 側**: `Assets/Scripts/XxxBridge.cs` を追加 → `Bootstrap.cs` の `BuildBridges()` に追記
2. **型定義**: `mobile/lib/xreal/types.ts` に request/response 型を追加
3. **RN API**: `mobile/lib/xreal/` に薄いラッパー関数を書く (`captureXrealFrame` と同様のパターン)
4. **ビルド**: `make unity-export && npx expo prebuild -p android && npx expo run:android`
5. **検証**: `adb logcat Unity:V XxxBridge:V ReactNativeJS:V *:S` で双方向メッセージを確認

## デバッグコマンド集

```bash
# XR Loader 状態確認
adb logcat -c && adb logcat XREALXRLoader:V SessionManager:V *:S | head

# Unity lifecycle (Pause/Resume ループ検出)
adb logcat | grep -E "OnApplicationPause|PauseSession|ResumeSession"

# bridge メッセージ
adb logcat ReactNativeJS:V UnityManager:V CameraBridge:V *:S

# Beam Pro 認識確認 (DP Alt Mode で消える)
adb devices
```

## 避けるべきパターン

- **`.unity` ファイルを手動で編集してシーンを組む** → Git diff 読めない、壊れやすい。Bootstrap.cs で build する
- **Prefab をエディタで組み、Inspector から参照を繋ぐ** → 同上。コードで `AddComponent` して直接参照する
- **`UnityView` を複数マウント** → UnityPlayer は singleton、同時複数の View に attach は未定義挙動
- **`UnityBridgeView` を画面遷移で mount/unmount 繰り返す** → 可能だが XR Loader 再初期化が毎回走る。root にずっと置くか、モード B で一度だけ mount する
- **camera capture のフォールバック忘れ** — `useCameraCapture` は xreal-eye 失敗時に phone-back に自動フォールバック。この経路を削らないこと
