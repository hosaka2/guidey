# モバイルアプリ アーキテクチャ

Expo (React Native) で構築されたモバイルアプリの設計。

---

## 画面構成

```
(tabs)/index.tsx   → ホーム (モード選択: DIY / 料理)
  ↓
goal.tsx           → ゴール入力 → プラン自動生成 → 確認
  ↓
guide.tsx          → ガイド画面 (カメラ + 指示 + 自律モード)
settings.tsx       → API URL 設定
```

---

## ガイド画面 (guide.tsx)

### レイヤー構成

```
┌─ GestureHandlerRootView ──────────────────────────┐
│  [z=10] Header (SafeAreaView, モード名 + 自律バッジ) │
│  [z=0]  CameraView (全画面カメラプレビュー)           │
│  [z=10] Reference Image (右上, ピンチ拡大縮小)       │
│  [z=5]  Instruction Card (下部, Markdownレンダリング) │
│  [z=10] Bottom Bar (キャプチャ + 自律トグル + 音声)   │
└───────────────────────────────────────────────────┘
```

### Hook 構成

| Hook | 役割 |
|------|------|
| `useGuideApi` | SSEストリーミング、手動解析 |
| `useAutonomousLoop` | 自律キャプチャ→判定ループ |
| `useSpeechRecognition` | 音声Intent検出、TTS連携 |

### 状態管理

```typescript
// UI状態
instructionCollapsed: boolean    // 指示カード折りたたみ
stepsExpanded: boolean          // ステップ一覧展開
voiceEnabled: boolean           // 音声ON/OFF

// useGuideApi から
isLoading, lastInstruction, error, referenceImageUrl, currentStep, totalSteps, steps

// useAutonomousLoop から
isActive (isAutonomous), plan, currentStepIndex, captureIntervalMs

// useSpeechRecognition から
isListening
```

### 循環参照の解決パターン

`handleVoiceTrigger` が `useAutonomousLoop` の関数を参照し、`useAutonomousLoop` の `onStepAdvanced` が `useSpeechRecognition` の `pauseForTTS` を参照する循環依存を、**ref パターン**で解決:

```typescript
const advanceStepRef = useRef<() => void>(() => {});
// ... hook 宣言後に ref を同期
advanceStepRef.current = advanceStep;
// handleVoiceTrigger 内では ref 経由で呼ぶ
advanceStepRef.current();
```

---

## SSE ストリーミング

### クライアント実装 (useGuideApi)

XMLHttpRequest の `readyState >= 3` (LOADING) でプログレッシブにデータを読み取る。

```
1. FormData 構築 (画像 + mode + trigger_word + goal)
2. POST /guide/analyze/stream
3. onreadystatechange で新しいデータを逐次パース
4. "data: " プレフィックスを除去
5. meta イベント → ステップ情報更新
6. テキストチャンク → JSON.parse → fullText に追加
7. 文の区切り (。！？\n) → onSentence → TTS 読み上げ
8. [DONE] → onDone
```

### 文単位TTS

ストリーミング中に文が完成するたびに即座にTTSに投げる:
```
チャンク受信: "玉ねぎを"
チャンク受信: "みじん切りに"
チャンク受信: "します。" ← 「。」検出 → TTS: "玉ねぎをみじん切りにします"
チャンク受信: "次に..."
```

---

## 自律モード

### 状態遷移

```
手動モード ─[▶ボタン]→ 自律モード ─[⏸ボタン or 音声「待って」]→ 手動モード
```

### 適応的サンプリング

```
変化あり:   5秒間隔 (アクティブ)
3回変化なし: 15秒間隔 (スロー)
6回変化なし: 30秒間隔 (待機)
next/anomaly: 5秒にリセット
```

### ヒステリシス

2回連続で `next` 判定が出て初めてステップを進行。1回だけの `next` は無視（ブレ防止）。

### ステップ進行時の処理

1. `setCurrentStepIndex(nextIdx)`
2. `setLastInstruction()` で指示カード更新
3. `setReferenceImageUrl()` でお手本画像切替
4. `Speech.speak()` でTTS読み上げ
5. 音声認識を一時停止 → TTS完了後に再開

---

## 音声認識 (useSpeechRecognition)

### 技術スタック

- `expo-speech-recognition` (Development Build 必須、Expo Go 不可)
- `expo-speech` (TTS 読み上げ)
- 言語: `ja-JP`、`continuous: true`、`interimResults: true`

### TTS連携

```
音声認識中 → キーワード検出 → pauseForTTS() → 認識停止
  → Speech.speak() → onDone → resumeAfterTTS() → 認識再開
```

300ms の遅延を入れてオーディオセッション切り替えを待つ。

### iOS 18 対策

iOS 18 では3秒無音で `end` イベントが発火する。`shouldBeListening` ref で意図的な停止と区別し、自動再起動:

```typescript
useSpeechRecognitionEvent("end", () => {
  if (shouldBeListening.current && !pausedForTTS.current) {
    setTimeout(() => startRecognition(), 300);
  }
});
```

---

## ゴール画面 (goal.tsx)

### フロー

```
ゴール入力 → [プランを生成] → ローディング → プラン確認画面
  ├─ [このプランで開始] → guide.tsx (planId付き)
  ├─ [再生成] → 再度LLM呼び出し
  └─ [プランなしで開始] → guide.tsx (planIdなし、手動モード)
```

### プラン確認UI

生成されたステップリストを番号付きで表示。各ステップに visual_marker も表示。

---

## コンポーネント

| コンポーネント | ファイル | 説明 |
|-------------|---------|------|
| CameraView | `components/CameraView.tsx` | expo-camera ラッパー、`takePicture()` |
| Markdown | `react-native-markdown-display` | LLM出力のMarkdownレンダリング |
| ピンチズーム | `react-native-gesture-handler` + `reanimated` | お手本画像の拡大縮小 |

---

## 定数・設定

| ファイル | 内容 |
|---------|------|
| `constants/Config.ts` | DEFAULT_API_URL, GuideMode |
| `constants/modes.ts` | モード定義 (DIY/料理, 色, アイコン, プレースホルダー) |
| `contexts/ApiContext.tsx` | API URL の AsyncStorage 永続化 |
| `types/plan.ts` | Plan, PlanStep, JudgeResponse 型定義 |

---

## Development Build

音声認識 (`expo-speech-recognition`) はネイティブモジュールのため Expo Go では動作しない。

```bash
cd mobile
npx expo install expo-dev-client
npx expo prebuild --clean
npx expo run:ios --device
```

詳細なセットアップ手順は [README.md](../README.md) を参照。
