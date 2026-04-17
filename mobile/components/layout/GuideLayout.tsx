import { forwardRef } from "react";

import type { CameraViewHandle } from "@/components/CameraView";
import { useLayoutVariant } from "@/lib/hooks";

import { PhoneVRLayout } from "./PhoneVRLayout";
import { SmartGlassesLayout } from "./SmartGlassesLayout";

type Props = React.ComponentProps<typeof PhoneVRLayout>;

/**
 * バリアント自動選択レイアウト。設定/デバイス検出 (useLayoutVariant) に応じて
 * PhoneVR / SmartGlasses を切り替える。画面コードは常にこれだけ import すれば良い。
 */
export const GuideLayout = forwardRef<CameraViewHandle, Props>((props, ref) => {
  const variant = useLayoutVariant();
  if (variant === "smart-glasses") {
    return <SmartGlassesLayout ref={ref} {...props} />;
  }
  return <PhoneVRLayout ref={ref} {...props} />;
});
GuideLayout.displayName = "GuideLayout";
