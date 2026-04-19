import { NativeModule, requireNativeModule } from 'expo';
import { Platform } from 'react-native';

import type {
  ExpoUnityViewModuleEvents,
  UnityIncomingMessageEvent,
  UnityOutgoingMessage,
} from './ExpoUnityView.types';

declare class ExpoUnityViewModule extends NativeModule<ExpoUnityViewModuleEvents> {
  sendUnityMessage(message: UnityOutgoingMessage): Promise<void>;
}

// iOS 等にネイティブ実装がないため、Android 以外では no-op スタブを返す。
// こうすることで呼び出し側 (lib/xreal/bridge.ts 等) で Platform 分岐不要。
const nativeModule: ExpoUnityViewModule | null =
  Platform.OS === 'android' ? requireNativeModule<ExpoUnityViewModule>('ExpoUnityView') : null;

export function sendUnityMessage(message: UnityOutgoingMessage): Promise<void> {
  if (!nativeModule) return Promise.resolve();
  return nativeModule.sendUnityMessage(message);
}

/**
 * Unity → RN イベントを購読。return 値の unsubscribe で解除。
 * 非 Android では何もしない unsubscribe を返す。
 */
export function addUnityMessageListener(
  handler: (event: UnityIncomingMessageEvent) => void,
): () => void {
  if (!nativeModule) return () => {};
  const subscription = nativeModule.addListener('unityMessage', handler);
  return () => subscription.remove();
}

export function isUnityAvailable(): boolean {
  return nativeModule != null;
}
