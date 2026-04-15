from enum import Enum
from typing import Literal

from pydantic import BaseModel


class GuideMode(str, Enum):
    DIY = "diy"
    COOKING = "cooking"


class ModeConfig(BaseModel):
    prompt: str
    collection: str
    label: str = ""


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


MODE_CONFIGS: dict[GuideMode, ModeConfig] = {
    GuideMode.DIY: ModeConfig(
        prompt="プロの職人として、画像と手順書から次の1ステップを短く指示して。",
        collection="diy",
        label="DIY作業",
    ),
    GuideMode.COOKING: ModeConfig(
        prompt="プロのシェフとして、焼き加減や工程を判断し、次の1ステップを短く指示して。",
        collection="cooking",
        label="料理",
    ),
}
