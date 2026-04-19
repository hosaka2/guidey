from typing import Literal

from pydantic import BaseModel

# RAG コレクション一覧 (横断検索用)
RAG_COLLECTIONS = ["diy", "cooking"]


class RagResult(BaseModel):
    video_id: str = ""
    step_number: int
    total_steps: int
    text: str
    frame_url: str
    visual_marker: str = ""
    quality_score: float = 0.5


# --- 自律エージェント ---


class PlanStep(BaseModel):
    step_number: int
    text: str
    visual_marker: str = ""
    frame_path: str = ""


class JudgmentResult(BaseModel):
    judgment: Literal["continue", "next", "anomaly"]
    confidence: float = 0.5
    message: str = ""


# --- フィードバック ---
Sentiment = Literal["positive", "neutral", "negative", "plan_retry"]
FeedbackSource = Literal["voice", "tap"]
FeedbackTargetType = Literal["utterance", "step", "plan", "session"]


class Feedback(BaseModel):
    target_type: FeedbackTargetType
    sentiment: Sentiment
    source: FeedbackSource
    target_id: str = ""
    target_content: str = ""
    raw_content: str = ""
    session_id: str = ""
    step_index: int | None = None


class FailedPlan(BaseModel):
    plan_source_id: str
    task_description: str
    abandoned_at_step: int
    reason: str = ""
    rag_source_ids: str = ""


# --- 安全ルール (ドメインポリシー) ---

SAFETY_KEYWORDS: dict[str, str] = {
    "危険": "危険な作業が検出されました。注意してください。",
    "火": "火を使う作業です。換気と消火器の確認を。",
    "刃物": "刃物を使います。手元に注意してください。",
    "高所": "高所での作業です。足場を確認してください。",
    "電気": "電気系統の作業です。ブレーカーを確認してください。",
    "熱い": "高温注意。やけどに気をつけてください。",
}


def check_step_safety(step: PlanStep) -> tuple[str, str]:
    """ステップの安全確認。戻り値: (override, warning_message)."""
    text = step.text + " " + step.visual_marker
    for keyword, warning in SAFETY_KEYWORDS.items():
        if keyword in text:
            return "confirm", warning
    return "none", ""


def sanitize_llm_output(
    message: str,
    blocks: list[dict],
    max_message_length: int = 500,
    max_blocks: int = 5,
) -> tuple[str, list[dict]]:
    """LLM出力のサニタイズ (ドメインポリシー).

    - メッセージ長制限 (暴走防止)
    - ブロック数制限
    - 不適切コンテンツフィルタ (URL注入、スクリプト埋め込み)
    """
    # メッセージ長制限
    if len(message) > max_message_length:
        message = message[:max_message_length] + "…"

    # 危険パターン除去 (LLM injection / prompt leak 対策)
    _BLOCKED_PATTERNS = [
        "javascript:",
        "<script",
        "data:text/html",
        "system prompt",
        "ignore previous",
    ]
    msg_lower = message.lower()
    for pattern in _BLOCKED_PATTERNS:
        if pattern in msg_lower:
            message = "応答を生成できませんでした"
            break

    # ブロック数制限
    blocks = blocks[:max_blocks]

    # ブロック内のURL検証 (image/video)
    safe_blocks = []
    for b in blocks:
        if b.get("type") in ("image", "video"):
            url = b.get("url", "")
            if url and not url.startswith(("http://", "https://", "/")):
                continue  # 不正URL → 除外
        safe_blocks.append(b)

    return message, safe_blocks
