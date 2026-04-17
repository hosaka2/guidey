export type TextBlock = {
  type: "text";
  content: string;
  style: "normal" | "emphasis" | "warning";
};

export type ImageBlock = {
  type: "image";
  url: string;
  caption?: string;
};

export type VideoBlock = {
  type: "video";
  url: string;
  start_sec?: number;
  end_sec?: number;
};

export type TimerBlock = {
  type: "timer";
  duration_sec: number;
  label: string;
};

export type AlertBlock = {
  type: "alert";
  message: string;
  severity: "info" | "warning" | "danger";
};

export type Block = TextBlock | ImageBlock | VideoBlock | TimerBlock | AlertBlock;
