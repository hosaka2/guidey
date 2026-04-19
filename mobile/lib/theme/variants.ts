import { color, fontSize, radius, space } from "./tokens";

/**
 * 画面バリアント固有の調整。
 *
 * phone-landscape: 手持ち横持ち (VR ゴーグルに入れない)。3 カラムで情報密度高め。
 * phone-vr:        スマホを Cardboard 系 VR ゴーグルに装着。両目ステレオ分割、各視野は最小情報。
 * smart-glasses:   Xreal / Rokid 等の光学シースルーグラス。カメラ描画なし、透明背景、HUD 風。
 */

export type ThemeVariant = "phone-landscape" | "phone-vr" | "smart-glasses";

export type FontScale = Record<keyof typeof fontSize, number>;

export type Theme = {
  variant: ThemeVariant;
  space: typeof space;
  radius: typeof radius;
  fontSize: FontScale;
  color: typeof color;
  panelRadius: number;
  instructionFontSize: number;
  /** 画面に同時表示するブロック数上限 */
  maxBlocks: number;
  /** 背景レンダリング方針 */
  background: "camera" | "camera-stereo" | "transparent";
  /** HUD の文字コントラスト強調 (smart-glasses で true) */
  highContrast: boolean;
};

export const phoneLandscape: Theme = {
  variant: "phone-landscape",
  space,
  radius,
  fontSize,
  color,
  panelRadius: radius.md,
  instructionFontSize: fontSize.md,
  maxBlocks: 10,
  background: "camera",
  highContrast: false,
};

export const phoneVR: Theme = {
  variant: "phone-vr",
  space,
  radius,
  fontSize: { ...fontSize, md: 16, lg: 20 }, // レンズ越しなので少し大きめ
  color,
  panelRadius: radius.lg,
  instructionFontSize: fontSize.lg,
  maxBlocks: 3, // ステレオの片目はスペースが狭い
  background: "camera-stereo",
  highContrast: true,
};

export const smartGlasses: Theme = {
  variant: "smart-glasses",
  space,
  radius,
  fontSize: { ...fontSize, md: 18, lg: 24, xl: 32 },
  color: {
    ...color,
    bg: "transparent", // 光学透過のため黒=透明扱い
    fg: "#FFFFFF",
  },
  panelRadius: radius.lg,
  instructionFontSize: fontSize.xl,
  maxBlocks: 2,
  background: "transparent",
  highContrast: true,
};
