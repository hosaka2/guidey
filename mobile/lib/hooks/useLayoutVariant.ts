import { useApiContext } from "@/contexts/ApiContext";
import type { ThemeVariant } from "@/lib/theme";

/**
 * 現在のレイアウトバリアントを返す。Settings で永続化 (AsyncStorage)。
 *
 * - phone-landscape: 手持ち横持ち (既定)、3 カラム
 * - phone-vr:        Cardboard 系 VR ゴーグル装着、両目ステレオ分割
 * - smart-glasses:   光学シースルー (Xreal 等)、透明 HUD、カメラ描画なし
 */
export function useLayoutVariant(): ThemeVariant {
  return useApiContext().layoutVariant;
}
