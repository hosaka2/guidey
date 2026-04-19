import { useLayoutVariant } from "@/lib/hooks/useLayoutVariant";
import { phoneLandscape, phoneVR, smartGlasses, type Theme } from "./variants";

/** 現在のレイアウトバリアントに応じたテーマを返す。 */
export function useTheme(): Theme {
  const variant = useLayoutVariant();
  switch (variant) {
    case "phone-vr":
      return phoneVR;
    case "smart-glasses":
      return smartGlasses;
    case "phone-landscape":
    default:
      return phoneLandscape;
  }
}
