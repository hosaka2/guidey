import { requireNativeView } from 'expo';
import * as React from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import type { ExpoUnityViewProps } from './ExpoUnityView.types';

const NativeView: React.ComponentType<ExpoUnityViewProps> | null =
  Platform.OS === 'android' ? requireNativeView('ExpoUnityView') : null;

export default function ExpoUnityView({ style, children }: ExpoUnityViewProps) {
  if (!NativeView) return <View style={style}>{children}</View>;
  return (
    <View pointerEvents="box-none" style={style}>
      <NativeView style={StyleSheet.absoluteFill} />
      {children}
    </View>
  );
}
