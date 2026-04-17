from pydantic import BaseModel


class GuideResponse(BaseModel):
    instruction: str
    reference_image_url: str | None = None
    current_step: int | None = None
    total_steps: int | None = None


class StepSummary(BaseModel):
    step_number: int
    text: str
    frame_url: str


class StreamMeta(BaseModel):
    reference_image_url: str | None = None
    current_step: int | None = None
    total_steps: int | None = None
    steps: list[StepSummary] = []


# --- Step 3a: 自律エージェント ---


class PlanStepResponse(BaseModel):
    step_number: int
    text: str
    visual_marker: str
    frame_url: str


class PlanResponse(BaseModel):
    source_id: str
    title: str
    session_id: str = ""
    steps: list[PlanStepResponse]


# --- Step 3b: プラン自動生成 ---


class PlanGenerateRequest(BaseModel):
    goal: str


class SessionStartResponse(BaseModel):
    session_id: str


# --- フィードバック ---


class FeedbackRequest(BaseModel):
    target_type: str  # "utterance" | "step" | "plan" | "session"
    sentiment: str  # "positive" | "neutral" | "negative" | "plan_retry"
    source: str  # "voice" | "tap"
    target_id: str = ""
    target_content: str = ""
    raw_content: str = ""
    session_id: str = ""
    step_index: int | None = None


class FeedbackResponse(BaseModel):
    feedback_id: str
    status: str = "ok"
