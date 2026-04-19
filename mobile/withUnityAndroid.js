/**
 * Expo config plugin: RN アプリに Unity as Library (XREAL SDK 同梱) を統合する。
 *
 * 設計・ハマりどころ全体像は docs/xreal-unity-integration.md 参照。
 * ランタイムの Unity 呼び出しは自前モジュール `modules/expo-unity-view` (UnityPlayer
 * singleton 保持 + XREAL の currentActivity reflection 対応)。このプラグインは
 * Unity export された `unityLibrary` を Gradle に繋ぎ込む配線のみを担当。
 *
 * ---------------------------------------------------------------------------
 * セットアップで踏んだビルドエラーと、このプラグインで行った対処
 * ---------------------------------------------------------------------------
 *
 * (A) `Project with path ':unityLibrary:xrmanifest.androidlib' could not be found`
 *     → settings.gradle に XREAL SDK のサブモジュール include を追加 (①)
 *
 * (B) `Could not find :xreal-auto-log-1.2:` 等 XREAL .aar の解決失敗
 *     → allprojects.repositories に flatDir を追加して unityLibrary/libs を参照 (①.5)
 *     → unityLibrary/build.gradle にも直接 `repositories { flatDir { dirs 'libs' } }` を追記
 *       (Unity re-export されたら消えるので再度手で入れる)
 *
 * (C) `UPlayer.java:100 UnityPlayer を FrameLayout に変換できません` (歴史的)
 *     → 既製の `@azesmway` / `@artmajeur` react-native-unity で発生していた Unity 6
 *       非互換。現在は `modules/expo-unity-view` (UnityPlayerForActivityOrService ベース)
 *       に置き換えたため該当エラー自体が出ない。過去対処のリファレンスとして記載。
 *
 * (D) `Could not get unknown property 'unity.androidNdkPath'`
 *     → gradle.properties に `unity.androidNdkPath` / `unity.androidSdkPath` を追加 (④)
 *     → NDK パスは Unity Hub に同梱のものを指す必要あり (Android Studio の NDK だと
 *       バージョン違いで IL2CPP コンパイルが通らないことがある)
 *
 * (E) `Manifest merger failed: Attribute application@enableOnBackInvokedCallback`
 *     → app 側 false / unityLibrary 側 true で衝突 →
 *       AndroidManifest の <application> に `tools:replace` を追加 (②.5)
 *
 * (F) `Manifest merger failed: minSdkVersion 24 cannot be smaller than version 29`
 *     → unityLibrary が minSdk 29 要件。
 *       gradle.properties で `android.minSdkVersion=29` を設定して ExpoRootProject
 *       全体を引き上げる (④)。app/build.gradle 側の defaultConfig での上書きは
 *       ExpoRootProject 設定に負けるので効かない。
 *
 * (G) `Task ':app:mergeDebugJniLibFolders' uses this output of task
 *       ':unityLibrary:buildIl2Cpp' without declaring an explicit dependency`
 *     → Gradle 8 の暗黙依存チェック厳格化。app/build.gradle に
 *       dependsOn(':unityLibrary:buildIl2Cpp') を注入 (②)
 *
 * (H) Beam Pro 起動時に guidey ではなく XREAL 経由で Unity 画面が直接起動
 *     → XREAL SDK が `NRXRActivity` に MAIN+LAUNCHER を付与している。
 *       manifest merger に `tools:node="remove"` で削除指示 (②.5)
 *
 * ---------------------------------------------------------------------------
 * そのほか (プラグイン外で必要な手順):
 *   - app.json の ios ブロックに `UISupportedInterfaceOrientations` を明示
 *     (iOS でデバイス回転に追従しない問題への対処。Android 側には関係なし)
 *   - JAVA_HOME は asdf-java 経由で zulu-17 を `asdf set --home java ...` で globals 設定
 *   - Beam Pro を adb 認識させるには USB ポートの選択が重要
 *     (充電専用ポートだと DP Alt Mode になって adb デバイスとして見えない)
 *   - Beam Pro の純正ランチャーは通常アプリを隠すので、
 *     起動は `設定 > アプリ > guidey > 開く` か `adb shell monkey -p com.guidey.app -c LAUNCHER 1`
 */
const {
    withSettingsGradle,
    withProjectBuildGradle,
    withAppBuildGradle,
    withAndroidManifest,
    withStringsXml,
    withGradleProperties,
  } = require('@expo/config-plugins');

  const withUnityAndroid = (config) => {
    // ① settings.gradle に unityLibrary + XREAL SDK サブモジュールを include
    //    (B) `:unityLibrary:xrmanifest.androidlib` が見つからない対策
    config = withSettingsGradle(config, (config) => {
      const unitySettings = `
  // --- Unity Integration ---
  include ':unityLibrary'
  project(':unityLibrary').projectDir = new File('../unity/builds/android/unityLibrary')
  include ':unityLibrary:xrmanifest.androidlib'
  // -------------------------
  `;
      if (!config.modResults.contents.includes("include ':unityLibrary'")) {
        config.modResults.contents += unitySettings;
      }
      return config;
    });

    // ①.5 ルート build.gradle の allprojects.repositories に flatDir を追加
    //     (B) XREAL SDK の .aar (xreal-auto-log, nr_loader, nr_common 等) を
    //     unityLibrary/libs/ から解決するため
    config = withProjectBuildGradle(config, (config) => {
      let contents = config.modResults.contents;
      if (!contents.includes("unityLibrary/libs")) {
        contents = contents.replace(
          /allprojects\s*\{\s*repositories\s*\{/,
          `allprojects {
  repositories {
    flatDir {
      dirs "\${project(':unityLibrary').projectDir}/libs"
    }`
        );
      }
      config.modResults.contents = contents;
      return config;
    });

    // ② app/build.gradle:
    //    - jniLibs.srcDirs 追加 (Unity の .so を app に含める)
    //    - minSdk 29 (F: unityLibrary 要件。ただし root project 側も引き上げが必要 → ④)
    //    - implementation project(':unityLibrary')
    //    - dependsOn(':unityLibrary:buildIl2Cpp') (G: Gradle 8 の暗黙依存エラー対策)
    config = withAppBuildGradle(config, (config) => {
      let contents = config.modResults.contents;

      if (!contents.includes('sourceSets.main.jniLibs.srcDirs')) {
        contents = contents.replace(
          /android\s*\{/,
          `android {
      sourceSets.main.jniLibs.srcDirs += "\${project(':unityLibrary').projectDir}/src/main/jniLibs"
      defaultConfig {
          minSdkVersion 29
      }`
        );
      }

      if (!contents.includes("implementation project(':unityLibrary')")) {
        contents += `
  dependencies {
      implementation project(':unityLibrary')
  }
  `;
      }

      if (!contents.includes("mergeDebugJniLibFolders")) {
        contents += `
  afterEvaluate {
      tasks.matching { it.name.startsWith('merge') && it.name.endsWith('JniLibFolders') }.configureEach {
          dependsOn(':unityLibrary:buildIl2Cpp')
      }
  }
  `;
      }
      config.modResults.contents = contents;
      return config;
    });

    // ②.5 AndroidManifest.xml:
    //     - (E) enableOnBackInvokedCallback の衝突を app 側優先で解決
    //     - (H) XREAL SDK の NRXRActivity の MAIN+LAUNCHER を削除
    //           (残すと Beam Pro で直接 Unity 画面が立ち上がってしまう)
    config = withAndroidManifest(config, (config) => {
      const manifest = config.modResults.manifest;
      if (!manifest.$['xmlns:tools']) {
        manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
      }
      const application = manifest.application?.[0];
      if (application) {
        const existing = application.$['tools:replace'] || '';
        const attrs = new Set(existing.split(',').map((s) => s.trim()).filter(Boolean));
        attrs.add('android:enableOnBackInvokedCallback');
        application.$['tools:replace'] = [...attrs].join(',');

        application.activity = application.activity || [];
        const alreadyRemoved = application.activity.some(
          (a) => a.$?.['android:name'] === 'ai.nreal.activitylife.NRXRActivity' && a.$?.['tools:node'] === 'remove'
        );
        if (!alreadyRemoved) {
          application.activity.push({
            $: {
              'android:name': 'ai.nreal.activitylife.NRXRActivity',
              'tools:node': 'remove',
            },
          });
        }
      }
      return config;
    });

    // ③ strings.xml に game_view_content_description リソースを追加
    //    (Unity の AndroidManifest から参照されるため)
    config = withStringsXml(config, (config) => {
      const hasGameViewDesc = config.modResults.resources.string?.some(
        (s) => s.$ && s.$.name === 'game_view_content_description'
      );
      if (!hasGameViewDesc) {
        config.modResults.resources.string = config.modResults.resources.string || [];
        config.modResults.resources.string.push({
          $: { name: 'game_view_content_description' },
          _: 'Game view',
        });
      }
      return config;
    });

    // ④ gradle.properties:
    //    - unityStreamingAssets= (Unity の build.gradle が参照)
    //    - (D) unity.androidNdkPath / unity.androidSdkPath を buildIl2Cpp 用に注入
    //    - (F) android.minSdkVersion=29 で ExpoRootProject 全体を 29 に引き上げる
    //          (app 側 defaultConfig での上書きは ExpoRootProject に負けるのでここで設定)
    config = withGradleProperties(config, (config) => {
      const ensureProp = (key, value) => {
        const exists = config.modResults.some(
          (p) => p.type === 'property' && p.key === key
        );
        if (!exists) {
          config.modResults.push({ type: 'property', key, value });
        }
      };
      ensureProp('unityStreamingAssets', '');
      ensureProp(
        'unity.androidNdkPath',
        '/Applications/Unity/Hub/Editor/6000.4.3f1/PlaybackEngines/AndroidPlayer/NDK'
      );
      ensureProp(
        'unity.androidSdkPath',
        `${process.env.HOME}/Library/Android/sdk`
      );
      ensureProp('android.minSdkVersion', '29');
      return config;
    });

    return config;
  };

  module.exports = withUnityAndroid;
