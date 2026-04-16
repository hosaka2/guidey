import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from src.application.dependencies import (
    get_chat_use_case,
    get_guide_use_case,
    get_judge_use_case,
    get_plan_generate_use_case,
    get_session_store,
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
    SessionStartResponse,
)
from src.application.guide.use_case import GuideUseCase
from src.config import settings
from src.infrastructure.repositories.plan_repository import get_plan_title, load_plan
from src.infrastructure.session.store import ValkeySessionStore

router = APIRouter()

ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
IMAGE_MAX_DIMENSION = 768


def _resize_image(image_bytes: bytes, max_dim: int = IMAGE_MAX_DIMENSION) -> bytes:
    import io
    from PIL import Image
    img = Image.open(io.BytesIO(image_bytes))
    if max(img.size) <= max_dim:
        return image_bytes
    img.thumbnail((max_dim, max_dim), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


async def _validate_image(file: UploadFile) -> bytes:
    if file.content_type and file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail=f"画像形式が非対応です: {file.content_type}")
    image_bytes = await file.read()
    if len(image_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="ファイルサイズが10MBを超えています")
    return _resize_image(image_bytes)


async def _get_session(session_id: str, store: ValkeySessionStore):
    """session_id からセッション取得。なければ 404。"""
    session = await store.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"セッション '{session_id[:8]}...' が見つかりません")
    return session


# === プラン取得/生成 (session 作成) ===


def _steps_to_dicts(steps) -> list[dict]:
    """PlanStep を session 保存用 dict に変換。"""
    return [
        {"step_number": s.step_number, "text": s.text,
         "visual_marker": s.visual_marker, "frame_path": getattr(s, "frame_path", "")}
        for s in steps
    ]


@router.post("/plan/generate", response_model=PlanResponse)
async def generate_plan(
    request: PlanGenerateRequest,
    use_case: PlanGenerateUseCase = Depends(get_plan_generate_use_case),
    store: ValkeySessionStore = Depends(get_session_store),
):
    """ゴールからステップリスト自動生成 + セッション作成。"""
    plan_response = await use_case.generate(goal=request.goal)

    # セッション作成
    from src.application.guide.plan_use_case import get_generated_steps
    steps = get_generated_steps(plan_response.source_id) or []
    session = await store.create(plan_response.source_id, _steps_to_dicts(steps))
    plan_response.session_id = session.session_id

    return plan_response


@router.get("/plan/{source_id}", response_model=PlanResponse)
async def get_plan(
    source_id: str,
    store: ValkeySessionStore = Depends(get_session_store),
):
    """プラン取得 + セッション作成。"""
    from src.application.guide.plan_use_case import _plan_cache, get_generated_steps

    for cached in _plan_cache.values():
        if cached.source_id == source_id:
            # generated プランのステップは _generated_steps_cache から取得
            steps_raw = get_generated_steps(source_id) or load_plan(source_id, settings.static_dir) or []
            session = await store.create(source_id, _steps_to_dicts(steps_raw))
            cached.session_id = session.session_id
            return cached

    steps = load_plan(source_id, settings.static_dir)
    if not steps:
        raise HTTPException(status_code=404, detail=f"プラン '{source_id}' が見つかりません")
    title = get_plan_title(source_id, settings.static_dir)

    session = await store.create(source_id, _steps_to_dicts(steps))

    return PlanResponse(
        source_id=source_id,
        title=title,
        session_id=session.session_id,
        steps=[
            PlanStepResponse(
                step_number=s.step_number, text=s.text,
                visual_marker=s.visual_marker,
                frame_url=f"/static/manual/{source_id}/{s.frame_path}" if s.frame_path else "",
            )
            for s in steps
        ],
    )


# === 自律判定 (session_id + image) ===


@router.post("/judge", response_model=JudgeResponse)
async def judge(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    is_calibration: str = Form("false"),
    use_case: JudgeUseCase = Depends(get_judge_use_case),
    store: ValkeySessionStore = Depends(get_session_store),
):
    """自律監視: session_id + 画像のみ。コンテキストは BE セッションから取得。"""
    image_bytes = await _validate_image(file)
    session = await _get_session(session_id, store)

    # pending を Valkey から取得+削除 (アトミック、session 本体とは独立)
    pending_msg, pending_blocks = await store.drain_pending(session_id)

    result = await use_case.judge(
        image_bytes=image_bytes,
        session=session,
        is_calibration=is_calibration.lower() == "true",
        pending_message=pending_msg,
        pending_blocks=pending_blocks,
    )

    # セッション更新
    session.add_observation(result.message)
    session.record_call(escalated=result.escalated)
    if result.judgment == "next":
        session.advance_step()
        result.current_step_index = session.current_step_index
    await store.save(session)

    return result


# === ユーザー対話 (session_id + message) ===


@router.post("/chat", response_model=ChatResponse)
async def chat(
    file: UploadFile | None = File(None),
    user_message: str = Form(...),
    session_id: str = Form(""),
    use_case: ChatUseCase = Depends(get_chat_use_case),
    store: ValkeySessionStore = Depends(get_session_store),
):
    """ユーザー対話: session_id + 発話のみ。"""
    image_bytes = None
    if file:
        image_bytes = await _validate_image(file)

    session = await _get_session(session_id, store) if session_id else None

    result = await use_case.chat(
        user_message=user_message,
        image_bytes=image_bytes,
        session=session,
    )

    # セッション更新 (chat_history, コスト)
    if session:
        session.add_chat_message("user", user_message)
        session.add_chat_message("assistant", result["message"])
        session.record_call(escalated=result["escalated"])
        await store.save(session)

    return ChatResponse(**result)


# === 1ショット解析 (セッション不要) ===


@router.post("/analyze", response_model=GuideResponse)
async def analyze(
    file: UploadFile = File(...),
    trigger_word: str = Form(...),
    goal: str = Form(""),
    use_case: GuideUseCase = Depends(get_guide_use_case),
):
    image_bytes = await _validate_image(file)
    return await use_case.analyze(image_bytes=image_bytes, trigger_word=trigger_word, goal=goal)


@router.post("/analyze/stream")
async def analyze_stream(
    file: UploadFile = File(...),
    trigger_word: str = Form(...),
    goal: str = Form(""),
    use_case: GuideUseCase = Depends(get_guide_use_case),
):
    image_bytes = await _validate_image(file)
    meta, chunks = await use_case.analyze_stream(image_bytes=image_bytes, trigger_word=trigger_word, goal=goal)

    async def event_generator():
        if meta:
            yield f"data: {json.dumps({'type': 'meta', **meta.model_dump(exclude_none=True)}, ensure_ascii=False)}\n\n"
        async for chunk in chunks:
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# === フィードバック ===


# === 探索モード (セッション開始のみ、プランなし) ===


@router.post("/session/start", response_model=SessionStartResponse)
async def start_session(
    store: ValkeySessionStore = Depends(get_session_store),
):
    """探索モード用セッション作成。プランなし。"""
    session = await store.create(plan_source_id="explore", plan_steps=[])
    return SessionStartResponse(session_id=session.session_id)


# === フィードバック ===


@router.post("/feedback", response_model=FeedbackResponse)
async def post_feedback(request: FeedbackRequest):
    from src.domain.guide.model import FailedPlan, Feedback
    from src.infrastructure.repositories.feedback_repository import SqliteFeedbackRepository
    repo = SqliteFeedbackRepository()
    fb = Feedback(**request.model_dump())
    fid = repo.save(fb)
    if request.sentiment == "plan_retry":
        fp = FailedPlan(plan_source_id=request.target_id, task_description=request.target_content,
                        abandoned_at_step=request.step_index or 0, reason=request.raw_content)
        repo.save_failed_plan(fp)
    return FeedbackResponse(feedback_id=fid)
