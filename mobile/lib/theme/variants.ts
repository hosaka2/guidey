import { color, fontSize, radius, space } from "./tokens";

/**
 * 画面バリアント固有の調整。
 * phone-vr: スマホを VR ゴーグルに入れて使う横持ち 3 カラム UI (情報密度高め)
 * smart-glasses: スマートグラス HUD (高コントラスト、少ない情報、大文字)
 */

export type ThemeVariant = "phone-vr" | "smart-glasses";

export type Theme = {
  variant: ThemeVariant;
  space: typeof space;
  radius: typeof radius;
  fontSize: typeof fontSize;
  color: typeof color;
  // レイアウト調整
  panelRadius: number;
  instructionFontSize: number;
  maxBlocks: number; // 画面に同時表示するブロック数上限
};

export const phoneVR: Theme = {
  variant: "phone-vr",
  space,
  radius,
  fontSize,
  color,
  panelRadius: radius.md,
  instructionFontSize: fontSize.md,
  maxBlocks: 10,
};

export const smartGlasses: Theme = {
  variant: "smart-glasses",
  space,
  radius,
  fontSize,
  color: {
    ...color,
    bg: "transparent", // カメラ透過
    fg: "#FFF",
  },
  panelRadius: radius.lg,
  instructionFontSize: fontSize.xl, // 大きく
  maxBlocks: 2, // 最小限
};
