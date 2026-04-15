import type { ComponentProps } from "react";
import type { MaterialCommunityIcons } from "@expo/vector-icons";

export type ModeKey = "cooking" | "diy";

type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

export type ModeDefinition = {
  key: ModeKey;
  label: string;
  labelWithMode: string;
  icon: IconName;
  color: string;
  description: string;
  goalPlaceholder: string;
};

export const MODES: Record<ModeKey, ModeDefinition> = {
  cooking: {
    key: "cooking",
    label: "料理",
    labelWithMode: "料理モード",
    icon: "pot-steam",
    color: "#FF6B35",
    description: "料理の手順をガイド",
    goalPlaceholder: "例: カレーを作りたい、パスタを茹でたい",
  },
  diy: {
    key: "diy",
    label: "DIY",
    labelWithMode: "DIYモード",
    icon: "hammer-wrench",
    color: "#2F95DC",
    description: "DIY作業をガイド",
    goalPlaceholder: "例: 棚を組み立てたい、壁に穴を開けたい",
  },
};

export const MODE_LIST = Object.values(MODES);
