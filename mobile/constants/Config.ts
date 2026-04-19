export const TRIGGER_WORDS = ["次", "できた", "教えて"];

/**
 * BE エンドポイント。ビルド時に `EXPO_PUBLIC_API_URL` 環境変数で決まる。
 */
export const API_URL =
  process.env.EXPO_PUBLIC_API_URL ?? "http://0.0.0.0:8000";
