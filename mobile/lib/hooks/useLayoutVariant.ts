import { useState } from "react";

import type { ThemeVariant } from "@/lib/theme";

/**
 * 現在のレイアウト / デバイスバリアントを返す。
 * 将来は SecureStore / Settings / デバイス判定で決定する。
 * 今は phone-vr 固定 (切り替え UI 未実装)。
 *
 * - phone-vr: スマホを VR ゴーグルに入れて使う横持ち 3 カラム
 * - smart-glasses: スマートグラス HUD (低情報密度)
 */
export function useLayoutVariant(): ThemeVariant {
  // 将来: useSettings() から取得
  const [variant] = useState<ThemeVariant>("phone-vr");
  return variant;
}
