import { forwardRef } from "react";

import type { CameraViewHandle } from "@/components/CameraView";
import { useLayoutVariant } from "@/lib/hooks";

import { PhoneLandscapeLayout } from "./PhoneLandscapeLayout";
import { PhoneVRLayout } from "./PhoneVRLayout";
import { SmartGlassesLayout } from "./SmartGlassesLayout";

type Props = React.ComponentProps<typeof PhoneLandscapeLayout>;

/**
 * バリアント自動選択レイアウト。
 * Settings の layoutVariant に応じて 3 種を切替。
 */
export const GuideLayout = forwardRef<CameraViewHandle, Props>((props, ref) => {
  const variant = useLayoutVariant();
  if (variant === "smart-glasses") return <SmartGlassesLayout ref={ref} {...props} />;
  if (variant === "phone-vr") return <PhoneVRLayout ref={ref} {...props} />;
  return <PhoneLandscapeLayout ref={ref} {...props} />;
});
GuideLayout.displayName = "GuideLayout";
