"""/guide/* ルータ.

責務:
  - 入力検証 (画像 MIME/サイズ、リサイズ)
  - UseCase の呼び出し (ルータは常に UseCase を通す、pass-through でも統一)
  - SSE ラッピング

業務ロジックは application/guide/*_use_case.py、
Graph 操作は infrastructure/agent/agent.py (AgentClient)。
"""

import json

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from src.application.dependencies import (
    get_analyze_use_case,
    get_chat_use_case,
    get_feedback_use_case,
    get_periodic_use_case,
    get_plan_generate_use_case,
    get_plan_query_use_case,
    get_session_use_case,
)
from src.application.guide.schemas.api import (
    FeedbackRequest,
    FeedbackResponse,
    GuideResponse,
    PeriodicSyncRequest,
    PeriodicSyncResponse,
    PlanGenerateRequest,
    PlanResponse,
    SessionStartResponse,
)
from src.application.guide.schemas.sse_schemas import SchemaExports
from src.application.guide.usecases.analyze_use_case import AnalyzeUseCase
from src.application.guide.usecases.chat_use_case import ChatUseCase
from src.application.guide.usecases.feedback_use_case import FeedbackUseCase
from src.application.guide.usecases.periodic_use_case import PeriodicUseCase
from src.application.guide.usecases.plan_query_use_case import PlanQueryUseCase
from src.application.guide.usecases.plan_use_case import PlanGenerateUseCase
from src.application.guide.usecases.session_use_case import SessionUseCase

router = APIRouter()

ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_FILE_SIZE = 10 * 1024 * 1024
IMAGE_MAX_DIMENSION = 768


# ============================================================================
# 入力検証 (ルータの責務)
# ============================================================================


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


def _sse_stream(event_iter):
    """(event_name, data) AsyncIterator → SSE 文字列 generator。"""

    async def gen():
        async for event, data in event_iter:
            yield f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

    return gen()


# ============================================================================
# プラン
# ============================================================================


@router.post("/plan/generate", response_model=PlanResponse)
async def generate_plan(
    request: PlanGenerateRequest,
    generate_uc: PlanGenerateUseCase = Depends(get_plan_generate_use_case),
    query_uc: PlanQueryUseCase = Depends(get_plan_query_use_case),
):
    return await query_uc.generate_and_inject(
        goal=request.goal,
        session_id=request.session_id,
        generate_uc=generate_uc,
    )


@router.get("/plan/{source_id}", response_model=PlanResponse)
async def get_plan(
    source_id: str,
    session_id: str,
    uc: PlanQueryUseCase = Depends(get_plan_query_use_case),
):
    return await uc.get(source_id=source_id, session_id=session_id)


# ============================================================================
# 自律判定 (/periodic)
# ============================================================================


@router.post("/periodic")
async def periodic(
    file: UploadFile = File(...),
    session_id: str = Form(...),
    is_calibration: str = Form("false"),
    stage1_result: str = Form(""),  # エッジ推論の持ち込み (Stage1Output JSON)
    uc: PeriodicUseCase = Depends(get_periodic_use_case),
):
    image_bytes = await _validate_image(file)
    return StreamingResponse(
        _sse_stream(
            uc.astream(
                session_id=session_id,
                image_bytes=image_bytes,
                is_calibration=is_calibration.lower() == "true",
                stage1_result_json=stage1_result,
            )
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/periodic/sync", response_model=PeriodicSyncResponse)
async def periodic_sync(
    request: PeriodicSyncRequest,
    uc: PeriodicUseCase = Depends(get_periodic_use_case),
):
    """エッジ LLM 経路の state 同期 (画像なし、LLM 呼び出しなし).

    モバイルが on-device で stage1 を回している間、BE の current_step_index /
    recent_observations が古くなる。10 秒間隔程度でこのエンドポイントを呼んで
    checkpointer に書き戻す。
    """
    result = await uc.sync(
        session_id=request.session_id,
        current_step_index=request.current_step_index,
        new_observations=request.new_observations,
    )
    return PeriodicSyncResponse(**result)


# ============================================================================
# ユーザー対話 (/chat) — ChatUseCase (ephemeral seed が絡むため)
# ============================================================================


@router.post("/chat")
async def chat(
    file: UploadFile | None = File(None),
    user_message: str = Form(...),
    session_id: str = Form(...),
    stage1_result: str = Form(""),
    uc: ChatUseCase = Depends(get_chat_use_case),
):
    image_bytes = await _validate_image(file) if file else None
    return StreamingResponse(
        _sse_stream(
            uc.astream(
                session_id=session_id,
                user_message=user_message,
                image_bytes=image_bytes,
                stage1_result_json=stage1_result,
            )
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ============================================================================
# 1-shot 解析 (セッション不要)
# ============================================================================


@router.post("/analyze", response_model=GuideResponse)
async def analyze(
    file: UploadFile = File(...),
    trigger_word: str = Form(...),
    goal: str = Form(""),
    uc: AnalyzeUseCase = Depends(get_analyze_use_case),
):
    image_bytes = await _validate_image(file)
    return await uc.analyze(image_bytes=image_bytes, trigger_word=trigger_word, goal=goal)


@router.post("/analyze/stream")
async def analyze_stream(
    file: UploadFile = File(...),
    trigger_word: str = Form(...),
    goal: str = Form(""),
    uc: AnalyzeUseCase = Depends(get_analyze_use_case),
):
    image_bytes = await _validate_image(file)
    meta, chunks = await uc.analyze_stream(
        image_bytes=image_bytes,
        trigger_word=trigger_word,
        goal=goal,
    )

    async def event_generator():
        if meta:
            yield f"data: {json.dumps({'type': 'meta', **meta.model_dump(exclude_none=True)}, ensure_ascii=False)}\n\n"
        async for chunk in chunks:
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ============================================================================
# 探索モード: セッション開始のみ
# ============================================================================


@router.post("/session/start", response_model=SessionStartResponse)
async def start_session(uc: SessionUseCase = Depends(get_session_use_case)):
    session_id = await uc.start()
    return SessionStartResponse(session_id=session_id)


# ============================================================================
# フィードバック
# ============================================================================


@router.post("/feedback", response_model=FeedbackResponse)
async def post_feedback(
    request: FeedbackRequest,
    uc: FeedbackUseCase = Depends(get_feedback_use_case),
):
    return uc.submit(request)


# ============================================================================
# スキーマ公開 (OpenAPI 用): SSE / form-data の中身の型をクライアントに配る
# ============================================================================


@router.get("/schemas", response_model=SchemaExports, include_in_schema=True)
async def _schemas() -> SchemaExports:
    """クライアント型生成専用 (openapi-typescript で拾う)。実呼び出し不要。"""
    raise NotImplementedError
