import { addUnityMessageListener, isUnityAvailable, sendUnityMessage } from "expo-unity-view";

import type { UnityRequest, UnityResponse } from "./types";

/**
 * Unity と RN の request-response bridge (singleton)。
 *
 * Unity の postMessage は単方向 fire-and-forget なので、JS 側で相関 ID を振って
 * Promise 化し、Unity 側 (CameraBridge.cs 等) から同じ ID で echo された
 * メッセージで resolve する。
 *
 * ネイティブ層は local Expo Module `expo-unity-view` (自前 Unity ラッパー)。
 * RN 画面遷移で UnityPlayer が pause されないように UnityManager が singleton で保持。
 *
 * 使い方:
 *   - アプリ root に <UnityBridgeView /> を一度だけ配置 (listener の start/stop を担う)
 *   - `await unityBridge.send({ gameObject: "CameraBridge", method: "Capture" })`
 */

type Pending = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class UnityBridge {
  private pending = new Map<string, Pending>();
  private unsubscribe: (() => void) | null = null;

  /** listener を起動 (非 Android では no-op)。UnityBridgeView から呼ぶ。 */
  start(): void {
    if (this.unsubscribe || !isUnityAvailable()) return;
    this.unsubscribe = addUnityMessageListener((e) => this.handleIncoming(e.message));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** ネイティブ有効 かつ listener 起動済みか。 */
  isStarted(): boolean {
    return this.unsubscribe != null;
  }

  /**
   * Unity にコマンド送信、対応する応答を待つ。
   * @param gameObject Unity GameObject 名 (例 "CameraBridge")
   * @param method Unity 側メソッド名 (例 "Capture")
   * @param args 任意パラメータ
   * @param timeoutMs 既定 5000ms
   */
  async send<T = unknown>(opts: {
    gameObject: string;
    method: string;
    args?: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<T> {
    if (!isUnityAvailable()) throw new Error("Unity module not available on this platform");

    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const req: UnityRequest = { id, method: opts.method, args: opts.args };
    const payload = JSON.stringify(req);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Unity bridge timeout: ${opts.gameObject}.${opts.method}`));
        }
      }, opts.timeoutMs ?? 5000);

      this.pending.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });

      sendUnityMessage({
        objectName: opts.gameObject,
        methodName: opts.method,
        message: payload,
      }).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  /** Unity からのメッセージ文字列をパースして pending を resolve。 */
  private handleIncoming(raw: string): void {
    let msg: UnityResponse;
    try {
      msg = JSON.parse(raw) as UnityResponse;
    } catch (e) {
      console.warn("[unity/bridge] invalid message:", raw.slice(0, 80), e);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) {
      if (__DEV__) console.log("[unity/bridge] unmatched response", msg);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);

    if (msg.error) {
      p.reject(new Error(msg.error));
      return;
    }
    // data は string (Unity JsonUtility がネスト JSON を文字列で載せる) or object
    let data: unknown = msg.data ?? null;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        /* 生文字列のまま返す */
      }
    }
    p.resolve(data);
  }
}

export const unityBridge = new UnityBridge();
