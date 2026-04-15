import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from src.application.dependencies import (
    get_chat_use_case,
    get_guide_use_case,
    get_judge_use_case,
    get_plan_generate_use_case,
)
from src.application.guide.chat_use_case import ChatUseCase
from src.application.guide.judge_use_case import JudgeUseCase
from src.application.guide.plan_use_case import PlanGenerateUseCase
from src.application.guide.schemas import (
    ChatResponse,
    FeedbackRequest,
    FeedbackResponse,
    GuideResponse,
    JudgeResponse,
    PlanGenerateRequest,
    PlanResponse,
    PlanStepResponse,
)
from src.application.guide.use_case import GuideUseCase
from src.config import settings
from src.domain.guide.model import GuideMode
from src.infrastructure.repositories.plan_repository import get_plan_title, load_plan

router = APIRouter()

ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB


async def _validate_image(file: UploadFile) -> bytes:
    if file.content_type and file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"画像形式が非対応です: {file.content_type} (JPEG/PNG/WebP のみ)",
        )
    image_bytes = await file.read()
    if len(image_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="ファイルサイズが10MBを超えています")
    return image_bytes


@router.post("/analyze", response_model=GuideResponse)
async def analyze(
    file: UploadFile = File(...),
    mode: GuideMode = Form(...),
    trigger_word: str = Form(...),
    goal: str = Form(""),
    use_case: GuideUseCase = Depends(get_guide_use_case),
):
    image_bytes = await _validate_image(file)
    return await use_case.analyze(
        image_bytes=image_bytes,
        mode=mode,
        trigger_word=trigger_word,
        goal=goal,
    )


@router.post("/analyze/stream")
async def analyze_stream(
    file: UploadFile = File(...),
    mode: GuideMode = Form(...),
    trigger_word: str = Form(...),
    goal: str = Form(""),
    use_case: GuideUseCase = Depends(get_guide_use_case),
):
    image_bytes = await _validate_image(file)
    meta, chunks = await use_case.analyze_stream(
        image_bytes=image_bytes,
        mode=mode,
        trigger_word=trigger_word,
        goal=goal,
    )

    async def event_generator():
        # メタ情報を最初に送信 (RAG結果がある場合)
        if meta:
            meta_json = json.dumps(
                {"type": "meta", **meta.model_dump(exclude_none=True)},
                ensure_ascii=False,
            )
            yield f"data: {meta_json}\n\n"

        # テキストチャンクをストリーミング (JSON文字列で改行を保持)
        async for chunk in chunks:
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- Step 3b: プラン自動生成 (※ /plan/{source_id} より先に定義) ---


@router.post("/plan/generate", response_model=PlanResponse)
async def generate_plan(
    request: PlanGenerateRequest,
    use_case: PlanGenerateUseCase = Depends(get_plan_generate_use_case),
):
    """ゴールからステップリストを自動生成."""
    return await use_case.generate(
        goal=request.goal,
        mode=request.mode,
    )


# --- Step 3a: 自律エージェント ---


@router.get("/plan/{source_id}", response_model=PlanResponse)
async def get_plan(source_id: str):
    """プランを取得 (静的ファイル → 生成キャッシュの順で検索)."""
    # 生成キャッシュから検索
    from src.application.guide.plan_use_case import _plan_cache
    for cached in _plan_cache.values():
        if cached.source_id == source_id:
            return cached

    # 静的ファイルから検索
    steps = load_plan(source_id, settings.static_dir)
    if not steps:
        raise HTTPException(status_code=404, detail=f"プラン '{source_id}' が見つかりません")
    title = get_plan_title(source_id, settings.static_dir)
    return PlanResponse(
        source_id=source_id,
        title=title,
        steps=[
            PlanStepResponse(
                step_number=s.step_number,
                text=s.text,
                visual_marker=s.visual_marker,
                frame_url=f"/static/manual/{source_id}/{s.frame_path}" if s.frame_path else "",
            )
            for s in steps
        ],
    )


@router.post("/judge", response_model=JudgeResponse)
async def judge(
    file: UploadFile = File(...),
    plan_source_id: str = Form(...),
    current_step_index: int = Form(...),
    recent_observations: str = Form("[]"),
    is_calibration: str = Form("false"),
    use_case: JudgeUseCase = Depends(get_judge_use_case),
):
    """自律監視: 画像から3択判定 (continue/next/anomaly)。シンプル、tool calling なし。"""
    image_bytes = await _validate_image(file)

    try:
        observations = json.loads(recent_observations)
        if not isinstance(observations, list):
            observations = []
    except (json.JSONDecodeError, TypeError):
        observations = []

    return await use_case.judge(
        image_bytes=image_bytes,
        source_id=plan_source_id,
        current_step_index=current_step_index,
        recent_observations=observations,
        is_calibration=is_calibration.lower() == "true",
    )


# --- ユーザー対話 (tool calling + 2段階LLM) ---


@router.post("/chat", response_model=ChatResponse)
async def chat(
    file: UploadFile | None = File(None),
    user_message: str = Form(...),
    plan_source_id: str = Form(""),
    current_step_index: int = Form(0),
    recent_observations: str = Form("[]"),
    use_case: ChatUseCase = Depends(get_chat_use_case),
):
    """ユーザー対話: テキスト/音声入力に応答。tool calling + 2段階LLM。"""
    image_bytes = None
    if file:
        image_bytes = await _validate_image(file)

    try:
        observations = json.loads(recent_observations)
        if not isinstance(observations, list):
            observations = []
    except (json.JSONDecodeError, TypeError):
        observations = []

    # プラン読み込み (current/next step 取得用)
    current_step = None
    next_step = None
    plan_steps = None
    if plan_source_id:
        from src.application.guide.plan_use_case import get_generated_steps
        steps = load_plan(plan_source_id, settings.static_dir)
        if not steps:
            steps = get_generated_steps(plan_source_id)
        if steps:
            plan_steps = steps
            if 0 <= current_step_index < len(steps):
                current_step = steps[current_step_index]
            if current_step_index + 1 < len(steps):
                next_step = steps[current_step_index + 1]

    result = await use_case.chat(
        user_message=user_message,
        image_bytes=image_bytes,
        current_step=current_step,
        next_step=next_step,
        recent_observations=observations,
        plan_steps=plan_steps,
    )

    return ChatResponse(**result)


# --- フィードバック ---


@router.post("/feedback", response_model=FeedbackResponse)
async def post_feedback(request: FeedbackRequest):
    """明示的フィードバックを保存."""
    from src.domain.guide.model import FailedPlan, Feedback
    from src.infrastructure.repositories.feedback_repository import SqliteFeedbackRepository

    repo = SqliteFeedbackRepository()
    fb = Feedback(**request.model_dump())
    fid = repo.save(fb)

    if request.sentiment == "plan_retry":
        fp = FailedPlan(
            plan_source_id=request.target_id,
            task_description=request.target_content,
            abandoned_at_step=request.step_index or 0,
            reason=request.raw_content,
        )
        repo.save_failed_plan(fp)

    return FeedbackResponse(feedback_id=fid)
