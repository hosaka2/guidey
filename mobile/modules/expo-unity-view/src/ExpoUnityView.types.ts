import type { StyleProp, ViewStyle } from 'react-native';

export type ExpoUnityViewProps = {
  children?: React.ReactNode;
  /** 外枠 View の style。UnityPlayer 本体は内部で absoluteFill される。 */
  style?: StyleProp<ViewStyle>;
};

// RN → Unity (UnitySendMessage 互換)
export type UnityOutgoingMessage = {
  objectName: string;
  methodName: string;
  message: string; // 呼び出し側で JSON.stringify する運用
};

// Unity → RN (単一イベント)
export type UnityIncomingMessageEvent = {
  message: string; // Unity 側からの文字列。必要なら JS 側で parse
};

export type ExpoUnityViewModuleEvents = {
  // EventEmitter のリスナー型に合わせ、関数シグネチャで表現
  unityMessage: (event: UnityIncomingMessageEvent) => void;
};
