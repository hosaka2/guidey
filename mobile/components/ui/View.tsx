/**
 * View のデザインシステムラッパ (imports-design-system-folder)。
 * アプリコードは `@/components/ui` から import し、react-native 直接参照しない。
 * Tamagui の View を経由しておくと、後日テーマ切り替えやプラットフォーム差分を
 * 一箇所で吸収できる。
 */
export { View } from "@tamagui/core";
export type { ViewProps } from "@tamagui/core";
