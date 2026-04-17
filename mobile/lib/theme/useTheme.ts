import { useLayoutVariant } from "@/lib/hooks/useLayoutVariant";
import { phoneVR, smartGlasses, type Theme } from "./variants";

/** 現在のレイアウトバリアントに応じたテーマを返す。 */
export function useTheme(): Theme {
  const variant = useLayoutVariant();
  return variant === "smart-glasses" ? smartGlasses : phoneVR;
}
