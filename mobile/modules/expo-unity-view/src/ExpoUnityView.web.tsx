import * as React from 'react';
import { View } from 'react-native';

import type { ExpoUnityViewProps } from './ExpoUnityView.types';

export default function ExpoUnityView({ style, children }: ExpoUnityViewProps) {
  return <View style={style}>{children}</View>;
}
