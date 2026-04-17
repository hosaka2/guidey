/** デザイントークン (共通)。variant (phone-vr / smart-glasses) で override される。 */

export const space = {
  xs: 2,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 24,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 18,
  xl: 22,
  xxl: 28,
} as const;

export const color: Record<string, string> = {
  bg: "#000",
  fg: "#fff",
  muted: "#999",
  accent: "#2F95DC",
  success: "#4ADE80",
  warning: "#FFA500",
  danger: "#FF4444",
  infoBg: "#E3F2FD",
  infoFg: "#1565C0",
  warningBg: "#FFF3E0",
  warningFg: "#E65100",
  dangerBg: "#FFEBEE",
  dangerFg: "#C62828",
};
