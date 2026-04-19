# モバイルアプリ アーキテクチャ

Expo (React Native) で構築。**Feature-sliced** 構造 + **design-system-folder** +
**レイアウトバリアント切替** を基本原則とする。画面は薄いオーケストレータで、
業務ロジックは `features/*` に、通信・エッジ推論・テーマ等は `lib/*` に集約。

Vercel の React Native Skills (`list-performance-*` / `ui-styling` / `react-state-dispatcher` /
`imports-design-system-folder` / `state-ground-truth` 等) に準拠。

---

## 画面構成

```
(tabs)/index.tsx      → ホーム (モード選択)
  ├─ goal.tsx         → ゴール入力 → /plan/generate → 確認
  ├─ explore.tsx      → 探索モード (プランなしチャット)
  ├─ guide.tsx        → ガイド画面 (プランあり、カメラ + 自律ループ + チャット)
  └─ settings.tsx     → API URL 等
```

---

## ディレクトリ構造

```
mobile/
├── app/                       Expo Router (薄い画面、各 ~120-245 行)
│   ├── _layout.tsx
│   ├── guide.tsx              features を composition するオーケストレータ
│   ├── explore.tsx
│   ├── goal.tsx
│   └── settings.tsx
│
├── features/                  機能モジュール (1 機能 = 1 ディレクトリ)
│   ├── autonomous/
│   │   ├── hooks/useAutonomousLoop.ts   定期監視 + エッジ LLM 差し込み
│   │   └── index.ts           barrel export (public API)
│   ├── chat/
│   │   ├── ChatInput.tsx      入力 UI (下部バー)
│   │   ├── hooks/useChat.ts   SSE 受信 + ブロック注入 + TTS
│   │   └── index.ts
│   ├── voice/
│   │   ├── hooks/
│   │   │   ├── useSpeechRecognition.ts   expo-speech-recognition ラップ
│   │   │   └── useVoiceIntents.ts        Intent → アクション dispatch
│   │   └── index.ts
│   ├── feedback/
│   │   └── hooks/useFeedback.ts          /feedback 送信
│   └── plan/
│       └── hooks/usePlan.ts              /plan/{id} 取得 + seed
│
├── components/                UI (デザインシステム + レイアウト + ドメイン)
│   ├── ui/                    ★ design-system-folder
│   │   ├── View.tsx / Text.tsx / Pressable.tsx  (Tamagui / RN をラップ)
│   │   ├── Panel.tsx          borderCurve: "continuous" を内包
│   │   └── index.ts           アプリコードは常にここから import
│   ├── layout/                ★ デバイスバリアント (3 種)
│   │   ├── PhoneLandscapeLayout.tsx  手持ち横持ち 3 カラム
│   │   ├── PhoneVRLayout.tsx         Cardboard 系 VR ゴーグル、両目ステレオ分割
│   │   ├── SmartGlassesLayout.tsx    Xreal 等、透明 HUD (カメラ描画なし)
│   │   ├── GuideLayout.tsx           useLayoutVariant で dispatch
│   │   └── index.ts
│   ├── blocks/                ブロック種別ごとのビュー (Text/Image/Video/Timer/Alert)
│   ├── BlockRenderer.tsx      blocks → 各 View にルーティング
│   ├── InstructionCard.tsx    Markdown 指示カード (折り畳み可)
│   ├── BottomBar.tsx          音声・入力・自律トグル
│   ├── CameraView.tsx         expo-camera ラップ (forwardRef)
│   ├── MediaPanel.tsx / TextPanel.tsx / TimerPanel.tsx
│   ├── FeedbackButtons.tsx
│   └── StepFeedback.tsx
│
├── lib/
│   ├── api/                   HTTP + SSE
│   │   ├── client.ts          base fetch + ApiError + attachFile
│   │   ├── stream.ts          SSE 低レイヤ (XMLHttpRequest, RN 制約回避)
│   │   ├── periodic.ts        callPeriodicStream
│   │   ├── chat.ts            callChatStream
│   │   ├── plan.ts            fetchPlan / generatePlan
│   │   ├── session.ts         startSession
│   │   ├── feedback.ts        submitFeedback
│   │   └── index.ts
│   ├── edge-llm/              ★ Stage1 差し込み口 (BE の seed_stage1 と対)
│   │   ├── types.ts           Stage1Runner interface, Stage1Input/Output, buildEdgePrompt
│   │   ├── cloud.ts           no-op (null 返す = BE 任せ)
│   │   ├── gemma-local.ts     llama.rn + Gemma 4 E2B VLM (mmproj 画像入力)
│   │   ├── model-manager.ts   GGUF バンドル (本体 + mmproj) の DL / キャッシュ
│   │   └── index.ts           getStage1Runner(mode), runner singleton
│   ├── hooks/useCameraCapture.ts  ★ カメラソース抽象 (phone-back / xreal-eye)
│   ├── xreal/                  ★ Unity bridge (XREAL SDK アダプタ経由)
│   │   ├── bridge.ts           singleton、postMessage + 相関 ID で Promise 化
│   │   ├── camera.ts           captureXrealFrame / isXrealCameraReady
│   │   ├── UnityBridgeView.tsx _layout で 1×1 hidden マウント
│   │   └── types.ts            request/response の型
│   ├── theme/                 ★ デザイン 2 系統
│   │   ├── tokens.ts          space / radius / fontSize / color
│   │   ├── variants.ts        phoneVR / smartGlasses テーマ
│   │   ├── useTheme.ts        現在バリアントに応じたテーマ返却
│   │   └── index.ts
│   ├── hooks/                 cross-cutting
│   │   ├── useAgentState.ts   Lock + TTS 競合 + 会話モード
│   │   ├── useBlockRouter.ts  blocks を text/timer/media に振り分け
│   │   ├── useLayoutVariant.ts "phone-vr" | "smart-glasses"
│   │   └── index.ts
│   └── types/
│       ├── blocks.ts          Block, Text/Image/Video/Timer/AlertBlock
│       ├── plan.ts            Plan, PlanStep
│       ├── stage.ts           StageEvent (BE SSE の生データ)
│       └── index.ts
│
└── contexts/
    └── ApiContext.tsx         apiUrl / セッション設定
```

---

## レイヤー責務

| 層 | 置き場 | やること | やらないこと |
|---|---|---|---|
| **Screen** | `app/*` | features を composition、URL パラメータ受取、ScreenOrientation | 業務ロジック、通信、ドメイン状態 |
| **Feature** | `features/*/hooks`, `features/*/*.tsx` | 1 機能の state + 振る舞い + 局所 UI | 他 feature への直接依存 (cross-cutting は `lib/hooks`) |
| **UI primitive** | `components/ui` | デザインシステム (View/Text/Pressable/Panel) | 業務状態 |
| **Layout** | `components/layout` | 配置のバリアント (PhoneVR / SmartGlasses) | ドメインロジック |
| **Domain UI** | `components/` | BlockRenderer / InstructionCard / CameraView | fetch |
| **Service** | `lib/api` | HTTP・SSE | 画面状態 |
| **Edge runner** | `lib/edge-llm` | Stage1 のローカル推論 | ネットワーク |
| **Theme** | `lib/theme` | トークン + variant | コンポーネント |
| **Shared hook** | `lib/hooks` | cross-cutting (複数 feature が触る) | feature 固有の振る舞い |

---

## 画面の薄さ

### guide.tsx (245 行)

```tsx
export default function GuideScreen() {
  const { plan } = usePlan(planId);
  const { sendChat } = useChat({ cameraRef, sessionId: plan?.session_id, ... });
  const { advanceStep } = useAutonomousLoop({ ..., isActive: isAutonomous });
  const onVoiceIntent = useVoiceIntents({ capture, advanceStep, askChat: sendChat, ... });
  useSpeechRecognition(onVoiceIntent, voiceEnabled);

  return (
    <GuideLayout ref={cameraRef} /* blocks */
      instructionCard={lastInstruction && <InstructionCard ... />}
      bottomBar={<BottomBar .../>} />
  );
}
```

### explore.tsx (123 行)

プランなしチャット専用。session は `startSession` で BE に seed させ、
`useChat` / `useVoiceIntents` / `GuideLayout` を組むだけ。

---

## エッジ LLM の差し込み口

BE 側に `seed_stage1` ノードがあり、`stage1_result` JSON を持ち込めば stage1 スキップで
stage2/safety から再開できる。モバイルはこれを活かせる形で設計済み。

### インターフェース

```ts
// lib/edge-llm/types.ts
export type Stage1Output = {
  judgment: "continue" | "next" | "anomaly";
  confidence: number;
  message: string;
  can_handle: boolean;
  escalation_reason: string;
};
export interface Stage1Runner {
  run(input: Stage1Input): Promise<Stage1Output | null>;
}
```

### 実装の 2 パターン

| Runner | 状態 | 置き場 | 技術 |
|---|---|---|---|
| `CloudStage1Runner` | ✓ 既定 (no-op、null 返す) | `cloud.ts` | - |
| `GemmaLocalRunner` | ✓ 実装済 (VLM 対応) | `gemma-local.ts` | llama.rn + Gemma 4 E2B GGUF (本体 Q4_K_M + mmproj-F16) |

> Apple FoundationModels は画像入力 (VLM) をサポートしないため対象外。
> Vision framework でのキャプション化 + LM の二段構成は真の VLM として成立しないので採用しない。

### 切替

```ts
// Settings 画面の edgeMode トグルで切替 (ApiContext + AsyncStorage 永続化)。
// useAutonomousLoop は ApiContext から edgeMode を読むので、呼び出し側は意識不要。

// 失敗時は cloud に自動フォールバック (try/catch + null、isReady() ガード)
```

---

## デザイン 2 バリアント

```ts
// lib/theme/variants.ts
export const phoneVR: Theme = { instructionFontSize: 15, maxBlocks: 10, ... };
export const smartGlasses: Theme = {
  instructionFontSize: 22,  // 大きく
  maxBlocks: 2,             // 情報最小
  color: { ..., bg: "transparent" },  // カメラ透過
};
```

```ts
// lib/hooks/useLayoutVariant.ts
// settings / SecureStore / デバイス判定で動的切替。
```

```tsx
// components/layout/GuideLayout.tsx
export const GuideLayout = forwardRef((props, ref) => {
  const variant = useLayoutVariant();
  return variant === "smart-glasses"
    ? <SmartGlassesLayout ref={ref} {...props} />
    : <PhoneVRLayout ref={ref} {...props} />;
});
```

### XREAL (Beam Pro) 対応

Unity を XREAL SDK アダプタ層として挟み、RN 本体はそのまま camera source 切替だけで XREAL Eye を使う。
設計方針 / 3D モードへの拡張計画は [future-design.md §XREAL](future-design.md#xreal-unity-adapter) を参照。
Unity プロジェクト側のセットアップ手順は [`mobile/unity/README.md`](../mobile/unity/README.md)。

### レイアウト比較

| 項目 | PhoneLandscapeLayout | PhoneVRLayout | SmartGlassesLayout |
|---|---|---|---|
| 想定端末 | 手持ち横持ちスマホ | Cardboard 系 VR ゴーグル装着 | Xreal / Rokid / Viture (光学シースルー) |
| カメラ | 全画面背景 | ステレオ両目 (iOS=CAReplicatorLayer / Android=view-shot フォールバック) | 描画せず (画面外マウント、推論用のみ) |
| カラム | 3 (Timer+Chat / Camera / Media) | 両目ステレオ分割 (IPD ガター) | 単一 HUD (上部+中央) |
| 文字 | 標準 (fontSize.md) | 大きめ (レンズ越し) | 最大 (遠視野) |
| 情報量 | maxBlocks=10 | maxBlocks=3 | maxBlocks=2 |
| 背景 | camera | camera-stereo | transparent (黒=透過) |
| 操作 | タップ + 音声 | 音声主体 (タップは底バーのみ) | ほぼ音声のみ |

### 設計判断

- **画面コードはレイアウト非依存**: `<GuideLayout>` しか触らない

---

## 音声 intent dispatch

```ts
// features/voice/hooks/useVoiceIntents.ts
export function useVoiceIntents(handlers: VoiceHandlers) {
  return useCallback((action: VoiceIntent, raw?: string) => {
    switch (action) {
      case "capture": if (!handlers.getIsLoading?.()) handlers.capture?.(); break;
      case "next_step":
      case "skip":    handlers.advanceStep?.(); break;
      case "pause":   if (handlers.getIsAutonomous?.()) handlers.toggleAutonomous?.(false); break;
      // ...
    }
  }, [handlers]);
}
```

- 画面は `useVoiceIntents({ capture, advanceStep, askChat: sendChat, ... })` で
  関数オブジェクトを渡すだけ
- `getIsAutonomous` / `getIsLoading` は関数で渡す → クロージャ鮮度を保つ

---

## SSE 通信 (lib/api/stream.ts)

React Native の `fetch` は body streaming 非対応のため **XMLHttpRequest**:

```ts
xhr.onreadystatechange = () => {
  if (xhr.readyState >= 3 && xhr.status === 200) {
    buf += xhr.responseText.substring(lastIndex);
    lastIndex = xhr.responseText.length;
    flushBuf();   // \n\n 区切りで SSE イベントをパース
  }
};
```

プロトコル (BEと合わせ):
```
event: stage  data: {"stage":1,"escalated":true,"message":"少し調べますね","blocks":[]}
event: stage  data: {"stage":2,"judgment":"next","message":"...","blocks":[...]}
event: done   data: {"current_step_index":2}
```

### 使い分け

| ファイル | エンドポイント | 用途 |
|---|---|---|
| `periodic.ts` | `POST /guide/periodic` | 自律ループ (3-20 秒間隔) |
| `chat.ts`     | `POST /guide/chat` | ユーザー発話 (単発) |
| `plan.ts`     | `GET/POST /guide/plan` | プラン取得/生成 (JSON) |
| `session.ts`  | `POST /guide/session/start` | 探索モード |
| `feedback.ts` | `POST /guide/feedback` | フィードバック (fire-and-forget) |

---

## 状態管理の方針

### 基本原則

- **state** は「UI に描画される値」だけに使う。それ以外 (カウンタ・フラグ・クロージャ鮮度用) は `useRef`
- **state更新は updater 形式**: `setX((prev) => ...)` で stale closure を回避 (`react-state-dispatcher`)
- **state-ground-truth**: 視覚値 (scale, opacity) はstateに置かず、論理状態 (`pressed` / `isActive`) から derive
- **UI内部の関心事はコンポーネント内に閉じる**: 画面は業務状態だけ持つ

### state / ref インベントリ (全 18 state / 20 ref)

#### 画面 (app/)

| 場所 | state | 必要性 |
|---|---|---|
| `guide.tsx` | `activeBlocks` / `lastInstruction` / `isAutonomous` / `voiceEnabled` / `showInput` / `inputValue` | UI 描画で必要 |
| `guide.tsx` | `cameraRef` | camera の imperative 呼び出し |
| `explore.tsx` | `sessionId` / `activeBlocks` / `showInput` / `inputValue` / `voiceEnabled` | UI 描画で必要 |
| `explore.tsx` | `cameraRef` | 同上 |

※ `instructionCollapsed` は `InstructionCard` 内部 state に移譲済 (画面は折り畳み状態を知る必要がない)。

#### feature hooks

| フック | state | ref | 理由 |
|---|---|---|---|
| `useAutonomousLoop` | `currentStepIndex` / `captureIntervalMs` | `isPeriodicRef` / `timerRef` / `noChangeCountRef` / `stuckCountRef` / `currentStepIndexRef` / `captureIntervalMsRef` / `onStepAdvancedRef` / `onAnomalyRef` / `onProactiveMessageRef` | state は画面で参照する。ref は (1) inflight guard (2) setTimeout ハンドル (3) カウンタ (再レンダー不要) (4) 非同期クロージャの鮮度維持 (5) callback 最新版参照 |
| `useChat` | - | `isSendingRef` | UI で描画しない同時実行ガード → ref |
| `usePlan` | `plan` / `error` | - | JSX で参照 |
| `useSpeechRecognition` | `isListening` | `shouldBeListening` / `pausedForTTS` / `lastTriggerTime` / `restartTimer` | state は UI バッジ表示。ref はセンサの guard と timer |
| `useVoiceIntents` | - | - | 純関数的 |

#### 共有 hook (lib/hooks)

| フック | state | ref | 理由 |
|---|---|---|---|
| `useAgentState` | - | `modeRef` / `isBusyRef` / `isSpeakingRef` / `currentSpeakSourceRef` / `pauseCallbackRef` / `resumeCallbackRef` | **全て ref**。UI に出さないランタイム調停フラグ + 外部コールバック登録スロット |
| `useLayoutVariant` | `variant` | - | 将来 settings から切替 (setter を実装予定) |

### `useRef` を積極採用した判断

以下の場合は state より ref を選ぶ:

1. **UIに描画しない同時実行ガード**: `isSendingRef`, `isPeriodicRef`, `isBusyRef`
2. **非同期クロージャで常に最新値が欲しい**: `currentStepIndexRef`, `onStepAdvancedRef` 等
3. **カウンタ (再レンダー不要)**: `noChangeCountRef`, `stuckCountRef`
4. **setTimeout / XHR ハンドル**: `timerRef`, `restartTimer`

この方針で `useAgentState` は全 ref (6 個)、`useAutonomousLoop` は state 2 個 + ref 9 個になっている。

---

## 状態遷移 (中核の 5 フロー)

### 1. 起動 → プラン取得 → 自律ループ開始

```
App mount
  └─ app/guide.tsx (planId URL param)
        ├─ usePlan(planId) → GET /guide/plan/{id}
        │     └─ plan state 更新 (steps + session_id)
        │
        └─ useEffect([plan])       ← plan 初回取得で発火
              ├─ setLastInstruction("ステップ 1 ...")
              ├─ appendBlocks([お手本画像])
              └─ setIsAutonomous(true)
                    ↓
              useAutonomousLoop の isActive=true
                    ↓
              useEffect([isActive]) → scheduleNext()
                    ↓
              setTimeout(runOnce, captureIntervalMs)
```

**ポイント**: 画面は `isAutonomous` を立てるだけ、タイマー制御は hook が完結。

### 2. 定期監視 tick → SSE → ステップ進行

```
runOnce:
  ├─ if (isPeriodicRef.current) return          ← tick 重複防止
  ├─ if (!acquireLock()) return                  ← chat 中なら skip
  ├─ isPeriodicRef.current = true
  ├─ [edgeMode !== "cloud"] → runner.run(...)   ← 将来: エッジ stage1
  │
  ├─ callPeriodicStream(apiUrl, uri, sessionId, onEvent, stage1Result?)
  │     └─ SSE 受信ループ
  │            ├─ stage1 escalated 中間 → onProactiveMessage
  │            └─ 最終 stage (stage=2 or stage=1 非エスカレーション):
  │                  ├─ judgment=next:
  │                  │     ├─ setCurrentStepIndex(newIdx)     ← BE の current_step_index に合わせる
  │                  │     ├─ resetInterval()
  │                  │     └─ onStepAdvanced(step, msg, blocks)
  │                  │           └─ 画面: setLastInstruction, appendBlocks, speak(transition)
  │                  ├─ judgment=anomaly:
  │                  │     ├─ resetInterval()
  │                  │     └─ onAnomaly(msg, blocks) → alert + speak(warn)  ← warn は割り込み可
  │                  └─ judgment=continue:
  │                        ├─ noChangeCount++, stuckCount++
  │                        ├─ updateInterval()                 ← 3s → 10s → 20s
  │                        └─ (msg あり) onProactiveMessage → speak(advise)
  │
  └─ finally: isPeriodicRef = false, releaseLock()
       次の scheduleNext が captureIntervalMs 後に発火
```

**ポイント**: BE の `current_step_index` が真実、モバイルはキャッシュ。ステップ進行時は `resetInterval` で頻度を戻す。

### 3. 音声 intent → チャット送信

```
ユーザー発話
  └─ useSpeechRecognition (expo-speech-recognition)
        └─ onResult(intent, raw)
              └─ useVoiceIntents dispatch
                    ├─ "capture": sendChat("教えて")
                    ├─ "next_step" / "skip": advanceStep()
                    ├─ "pause" / "resume": setIsAutonomous(v)
                    ├─ "repeat": speak(lastInstruction, respond)
                    ├─ "feedback_*": sendFeedback(sentiment, voice, raw)
                    └─ default (長文): sendChat(raw)

sendChat (useChat):
  ├─ if (isSendingRef.current) return       ← 二重発火防止
  ├─ isSendingRef.current = true
  ├─ enterConversation()                     ← modeRef = "conversing"
  │                                             → periodic の発話だけ抑制 (ループ自体は継続)
  ├─ acquireLock()                           ← periodic tick は skip される
  ├─ 画像撮影 (任意)
  ├─ callChatStream → 各 stage イベント:
  │     ├─ stage=1 escalated: onBlocks + speak(advise)  「少し調べますね」
  │     └─ 最終: onBlocks + speak(respond)
  └─ finally:
        ├─ releaseLock()
        ├─ setTimeout(exitConversation, 3000)  ← TTS 完了分の猶予
        └─ isSendingRef = false
```

### 4. 自律トグル OFF (手動 / voice "pause")

```
setIsAutonomous(false)                       ← state 更新
  └─ useAutonomousLoop の isActive=false
        └─ useEffect cleanup:
              ├─ clearTimeout(timerRef)      ← 次 tick を確実にキャンセル
              └─ timerRef = null
  ※ 現在 SSE 走行中の inflight tick は最後まで完走する (isPeriodicRef が false に戻るまで待つ)
  ※ これは意図した挙動 (途中で切ると state 不整合になるため)
```

### 5. TTS 競合調停 (useAgentState.speak)

```
speak(message, source, speakType):
  ├─ (guard 1) modeRef.current === "conversing" && source === "periodic" && speakType !== "warn"
  │     → return false                       ← 会話中は periodic を黙らせる
  │
  ├─ (guard 2) isSpeakingRef.current === true:
  │     ├─ speakType === "warn": Speech.stop()  ← 現 TTS を中断 (割り込み)
  │     └─ else: return false                   ← 先着優先で skip
  │
  ├─ isSpeakingRef = true
  ├─ pauseCallback()                        ← 音声認識を一時停止 (自分の声を拾わない)
  └─ Speech.speak(onDone/onStopped/onError → isSpeakingRef=false, resumeCallback())
```

**優先度**: `warn` > `transition` > `respond` = `advise`。warn だけが割り込み可能。

---

## 排他制御の 3 層

同時実行やレース状態を防ぐための 3 つのガードが、粒度を変えて重なっている:

| 層 | 実装 | 守る範囲 |
|---|---|---|
| **L1 Lock** | `acquireLock` / `releaseLock` (`useAgentState`) | `/periodic` と `/chat` の排他 — 同時に画像送信しない |
| **L2 Inflight guard** | `isPeriodicRef` (hook 内) / `isSendingRef` (useChat) | 同一フロー内での tick / 発火 の重複 |
| **L3 Mode** | `modeRef = "conversing"` | TTS 発話抑制のみ (ループやキャプチャは継続) |

### 重なり方

```
periodic tick   ─ L2 (isPeriodicRef) ─ L1 (acquireLock) ─ 実行
chat 送信       ─ L2 (isSendingRef)  ─ L1 (acquireLock) ─ 実行
                                                          ↓
                                           L3 mode=conversing で
                                           periodic の TTS のみ抑制
                                           (キャプチャ → BE 通信は継続)
```

### 意図的な非抑制

- `mode=conversing` 中でも **periodic のキャプチャと /periodic 呼び出しは止めない**
  (ユーザーが話してる間も作業は進んでいる前提)
- 止めたい場合は `isActive=false` にする (autonomous トグル OFF)

---

## クリーンアップと漏れ防止

| リソース | 片付け方 |
|---|---|
| `timerRef` (setTimeout) | `useAutonomousLoop` の useEffect cleanup で `clearTimeout` |
| `restartTimer` (音声再起動) | `useSpeechRecognition` の useEffect cleanup |
| `Speech.speak` | 画面 unmount で `Speech.stop()` 呼出 |
| `ExpoSpeechRecognitionModule` | 画面 unmount で `stopListening()` |
| 走行中の SSE | 画面 unmount時 XHR が GC される (未対応: 明示的 `abort`)。将来 AbortController 対応検討 |
| inflight `isPeriodicRef` | SSE 完走まで待つ (途中キャンセルしない) |

### 既知の軽微なリーク

- 画面を離れるタイミングで走行中 SSE があると、完了コールバックは空 state に書こうとして
  React の stale warning を吐く可能性あり。現状は `if (cancelled)` ガードで plan fetch だけは対策済。
  SSE にも同パターンを入れる or AbortController 使用が将来 TODO。

---

## RN スキル準拠チェック

| スキル | 適用箇所 | 状態 |
|---|---|---|
| `imports-design-system-folder` | `components/ui/` を全 app/features で経由 | ✓ |
| `ui-styling` (`gap`, `borderCurve: "continuous"`) | `Panel` / `ChatInput` / `SmartGlassesLayout` | ✓ |
| `ui-pressable` | RN `Pressable` のみ (TouchableOpacity 排除) | ✓ |
| `react-state-dispatcher` | `setCurrentStepIndex` 等 | ✓ |
| `state-ground-truth` | `isAutonomous` / `isActive` | ✓ |
| `list-performance-*` | blocks は最大 10-20 件の配列なので未適用 (将来 `@legendapp/list` 検討) | 将来 |
| `navigation-native-navigators` | Expo Router の native stack | ✓ |
| `rendering-text-in-text-component` | 全テキスト `Text` ラップ | ✓ |
| `rendering-no-falsy-and` | `cond ? <X /> : null` を徹底 | ✓ |

### 将来導入候補

- **React Compiler**: `useCallback` / `useMemo` 削減
- **Reanimated + GPU animation**: Panel 表示アニメ
- **FlashList / LegendList**: blocks 数増加時
- **expo-image**: 参考画像 (現在 `Image`)

---

## 環境変数 / 設定

| キー | 既定 | 用途 |
|---|---|---|
| `apiUrl` | `http://localhost:8000` | BE エンドポイント (settings 画面で変更) |
| `voiceEnabled` | `true` | 音声認識 on/off (画面内トグル) |
| `layoutVariant` | `phone-vr` | デザインバリアント (将来 settings 追加) |
| `edgeMode` | `cloud` | Stage1 実行場所 (将来 settings 追加) |

`ApiContext` が apiUrl を保持。将来的に `edgeMode` / `layoutVariant` を
`SecureStore` + Context で供給する想定。

---

## よくある拡張シナリオ

### 新しい feature を足す (例: タイマー共有)

```
features/timer-share/
  TimerShareController.tsx
  hooks/useTimerShare.ts
  index.ts          ← barrel (public API)
```

画面は `<TimerShareController />` を追加するだけ。

### 新しいレイアウト variant (例: タブレット)

1. `lib/theme/variants.ts` に `tablet: Theme` 追加
2. `lib/hooks/useLayoutVariant.ts` が `"tablet"` を返せるように
3. `components/layout/TabletLayout.tsx` 作成
4. `GuideLayout.tsx` の dispatch に追加

### エッジ stage1 実装 (gemma-local)

1. `llama.rn` 等を `package.json` に追加、config plugin 設定
2. 初回起動時モデルダウンロード (初期化画面で進捗)
3. `lib/edge-llm/gemma-local.ts` の `throw` を `inferJSON(prompt, image)` に置換
4. `useAutonomousLoop({ edgeMode: "gemma-local" })` で切替
5. BE 側は変更不要 (`seed_stage1` が受け入れ済み)

---

## 制約 / 注意

- **React Native fetch は streaming 非対応** → SSE は XHR 実装 (`lib/api/stream.ts`)
- **Tamagui v2 RC** を使用 (将来 stable に追従)
- **expo-speech-recognition** は SDK 52+ の native module (SDK 51 以下不可)
- **探索モード**: `session_id` なしの `/chat` は BE が ephemeral 作成、TTL 30 分で自動消滅
