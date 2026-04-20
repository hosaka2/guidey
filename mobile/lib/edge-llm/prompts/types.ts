import type { Stage1Input } from "../types";

export type EdgePromptOptions = {
  /** 画像を直接扱えない runner (Apple 等) が Vision で抽出したキャプション/OCR を挿す場所。
   *  VLM 直接入力可能な Gemma では空で良い。 */
  imageContext?: string;
};

export type EdgePromptBuilder = (
  input: Stage1Input,
  options?: EdgePromptOptions,
) => string;
