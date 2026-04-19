import type { UnityIncomingMessageEvent, UnityOutgoingMessage } from './ExpoUnityView.types';

export function sendUnityMessage(_message: UnityOutgoingMessage): Promise<void> {
  return Promise.resolve();
}

export function addUnityMessageListener(
  _handler: (event: UnityIncomingMessageEvent) => void,
): () => void {
  return () => {};
}

export function isUnityAvailable(): boolean {
  return false;
}
