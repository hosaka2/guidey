export const GuideMode = {
  DIY: "diy",
  COOKING: "cooking",
} as const;

export type GuideModeType = (typeof GuideMode)[keyof typeof GuideMode];

export const TRIGGER_WORDS = ["次", "できた", "教えて"];

export const DEFAULT_API_URL = "http://10.32.1.44:8000";
