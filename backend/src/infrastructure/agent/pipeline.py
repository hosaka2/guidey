"""2段階LLMパイプライン.

定期判定 (periodic) とユーザーアクション (user_action) を共通処理する。

  Stage 1 (fast): Gemma で即判定/応答
    → can_handle=true → 結果を返す
    → can_handle=false → Stage 2 へ

  Stage 2 (deep): HQ (Gemma 26b / Claude) + Tool Calling

ハーネス (安全装置):
  - タイムアウト: periodic 10s / user_action 20s
  - コスト上限: セッション単位の Stage2 呼び出し制限
  - 出力サニタイズ: メッセージ長制限、URL検証、injection対策
  - メトリクス: エスカレーション率、レイテンシ、呼び出し数
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Literal

from opentelemetry import trace

from src.common.json_utils import extract_json_object
from src.common.metrics import pipeline_metrics
from src.common.telemetry import get_tracer
from src.config import settings
from src.domain.guide.model import PlanStep, sanitize_llm_output
from src.domain.guide.service import GuideService
from src.infrastructure.agent.tools import build_hq_tools
from src.infrastructure.llm.base import LLMClient

tracer = get_tracer("guidey.pipeline")

logger = logging.getLogger(__name__)

PipelineType = Literal["periodic", "user_action"]


@dataclass
class PipelineInput:
    """パイプライン入力."""

    pipeline_type: PipelineType
    image_bytes: bytes | None = None
    user_message: str | None = None
    current_step: PlanStep | None = None
    next_step: PlanStep | None = None
    recent_observations: list[str] = field(default_factory=list)
    plan_steps: list[PlanStep] | None = None
    plan_source_id: str = ""
    # 進捗コンテキスト
    total_steps: int = 0
    # 会話履歴 (user_action のみ)
    chat_history: list[dict] = field(default_factory=list)  # [{role, content}]


@dataclass
class PipelineOutput:
    """パイプライン出力 (両ループ共通)."""

    # 判定 (periodic)
    judgment: str = "continue"  # continue | next | anomaly
    confidence: float = 0.5

    # 応答
    message: str = ""
    blocks: list[dict] = field(default_factory=list)

    # メタ
    escalated: bool = False
    source: Literal["fast", "deep"] = "fast"
    pipeline_type: PipelineType = "periodic"


def _parse_response(raw: str) -> dict:
    """LLM出力をパース。"""
    data = extract_json_object(raw)
    if not data:
        return {"message": raw, "can_handle": True}

    j = data.get("judgment", "continue")
    if j not in ("continue", "next", "anomaly"):
        j = "continue"

    blocks = data.get("blocks", [])
    if not isinstance(blocks, list):
        blocks = []

    return {
        "judgment": j,
        "confidence": max(0.0, min(1.0, float(data.get("confidence", 0.5)))),
        "message": str(data.get("message", "")),
        "can_handle": bool(data.get("can_handle", True)),
        "escalation_reason": str(data.get("escalation_reason", "")),
        "blocks": [b for b in blocks if isinstance(b, dict) and "type" in b],
    }


def _should_escalate(parsed: dict, pipeline_type: PipelineType) -> bool:
    """エスカレーション判定。

    periodic: anomaly + can_handle=false の時だけ (速度優先)
    user_action: can_handle=false の時 (正確性優先)
    """
    if parsed.get("can_handle", True):
        return False

    if pipeline_type == "periodic":
        return parsed.get("judgment") == "anomaly"
    else:
        return True


def _ms(t0: float) -> int:
    """経過ミリ秒."""
    return int((time.monotonic() - t0) * 1000)


def _get_timeout(pt: PipelineType) -> float:
    """パイプラインタイプに応じたタイムアウト値。"""
    if pt == "periodic":
        return settings.pipeline_timeout_periodic
    return settings.pipeline_timeout_user_action


def _sanitize(output: PipelineOutput) -> PipelineOutput:
    """出力サニタイズ (ドメインポリシー適用)."""
    output.message, output.blocks = sanitize_llm_output(
        message=output.message,
        blocks=output.blocks,
        max_message_length=settings.max_response_length,
        max_blocks=settings.max_blocks_per_response,
    )
    return output


async def run_two_stage_pipeline(
    input_data: PipelineInput,
    guide_service: GuideService,
    llm_client: LLMClient,
    hq_client: LLMClient | None = None,
    rag_client=None,
    embedding_client=None,
    session=None,
    session_store=None,
) -> PipelineOutput:
    """統一2段階パイプライン (ハーネス付き).

    user_action でエスカレーション時: Stage 1 を即返し、Stage 2 をバックグラウンド実行。
    Stage 2 の結果は session.pending_blocks に保存され、次の /judge で配信。
    """
    pt = input_data.pipeline_type
    timeout = _get_timeout(pt)

    try:
        result = await asyncio.wait_for(
            _run_pipeline_inner(
                input_data, guide_service, llm_client, hq_client,
                rag_client, embedding_client,
                session=session, session_store=session_store,
            ),
            timeout=timeout,
        )
        return _sanitize(result)

    except asyncio.TimeoutError:
        pipeline_metrics.record_timeout()
        logger.warning("[Pipeline/%s] TIMEOUT %.1fs", pt, timeout)
        msg = "すみません、処理に時間がかかっています。もう一度お試しください。" if pt == "user_action" else ""
        return PipelineOutput(
            judgment="continue",
            confidence=0.0,
            message=msg,
            pipeline_type=pt,
        )


async def _run_pipeline_inner(
    input_data: PipelineInput,
    guide_service: GuideService,
    llm_client: LLMClient,
    hq_client: LLMClient | None = None,
    rag_client=None,
    embedding_client=None,
    session=None,
    session_store=None,
) -> PipelineOutput:
    """パイプライン本体 (タイムアウトは外側で管理)."""
    _hq = hq_client or llm_client
    pt = input_data.pipeline_type
    lp = f"[Pipeline/{pt}]"
    t_start = time.monotonic()
    step_num = input_data.current_step.step_number if input_data.current_step else 0

    with tracer.start_as_current_span(
        "pipeline.run",
        attributes={
            "pipeline.type": pt,
            "pipeline.step": step_num,
            "pipeline.has_image": input_data.image_bytes is not None,
            "pipeline.user_message": (input_data.user_message or "")[:50],
        },
    ) as span:
        return await _run_pipeline_traced(
            span, input_data, guide_service, llm_client,
            _hq, rag_client, embedding_client,
            pt, lp, t_start,
            session=session, session_store=session_store,
        )


async def _run_pipeline_traced(
    span,
    input_data: PipelineInput,
    guide_service: GuideService,
    llm_client: LLMClient,
    hq_client: LLMClient,
    rag_client,
    embedding_client,
    pt: PipelineType,
    lp: str,
    t_start: float,
    session=None,
    session_store=None,
) -> PipelineOutput:
    # === ハーネス: コスト上限チェック ===
    over, reason = pipeline_metrics.is_over_budget(
        max_total=settings.session_max_total_calls,
        max_stage2=settings.session_max_stage2_calls,
    )
    if over:
        span.set_attribute("pipeline.budget_exceeded", True)
        span.set_status(trace.StatusCode.ERROR, reason)
        logger.warning("%s BUDGET_EXCEEDED %s", lp, reason)
        return PipelineOutput(
            judgment="continue", confidence=0.0,
            message="セッションの利用上限に達しました。しばらくお待ちください。",
            pipeline_type=pt,
        )

    # === Stage 1: Fast ===
    prompt = _build_stage1_prompt(input_data, guide_service)
    _log_start = logger.debug if pt == "periodic" else logger.info
    _log_start(
        "%s START step=%s user='%s'",
        lp,
        input_data.current_step.step_number if input_data.current_step else "-",
        (input_data.user_message or "")[:30],
    )

    t1 = time.monotonic()
    with tracer.start_as_current_span("pipeline.stage1") as s1_span:
        try:
            # Stage 1: tool calling なし (速度優先)
            # ツール実行は全て Stage 2 (HQ) で行う
            tool_results = []
            if input_data.image_bytes:
                text = await llm_client.analyze_image(input_data.image_bytes, prompt)
            else:
                text = await llm_client.generate_text(prompt)

            parsed = _parse_response(text)
            stage1_ms = _ms(t1)

            if tool_results:
                parsed["blocks"] = parsed.get("blocks", []) + tool_results

            s1_span.set_attributes({
                "stage1.latency_ms": stage1_ms,
                "stage1.judgment": parsed["judgment"],
                "stage1.confidence": parsed["confidence"],
                "stage1.can_handle": parsed["can_handle"],
                "stage1.tools": len(tool_results),
            })
            # periodic + continue は debug、それ以外は info
            _log_s1 = logger.debug if (pt == "periodic" and parsed["judgment"] == "continue") else logger.info
            _log_s1(
                "%s stage1 %dms j=%s conf=%.2f can_handle=%s tools=%d msg='%s'",
                lp, stage1_ms, parsed["judgment"], parsed["confidence"],
                parsed["can_handle"], len(tool_results), parsed["message"][:50],
            )

        except Exception as e:
            stage1_ms = _ms(t1)
            s1_span.set_status(trace.StatusCode.ERROR, str(e))
            logger.warning("%s stage1 FAIL %dms %s", lp, stage1_ms, e)
            pipeline_metrics.record_error()
            try:
                if input_data.image_bytes:
                    raw = await llm_client.analyze_image(input_data.image_bytes, prompt)
                else:
                    raw = await llm_client.generate_text(prompt)
                parsed = _parse_response(raw)
                tool_results = []
            except Exception:
                total_ms = _ms(t_start)
                logger.error("%s END %dms TOTAL_FAIL", lp, total_ms)
                pipeline_metrics.record_error()
                span.set_status(trace.StatusCode.ERROR, "total_fail")
                return PipelineOutput(message="応答に失敗しました", pipeline_type=pt)

    # === エスカレーション判定 ===
    if not _should_escalate(parsed, pt):
        total_ms = _ms(t_start)
        span.set_attributes({
            "pipeline.final_stage": 1,
            "pipeline.total_ms": total_ms,
            "pipeline.judgment": parsed["judgment"],
            "pipeline.escalated": False,
        })
        _log_end = logger.debug if (pt == "periodic" and parsed["judgment"] == "continue") else logger.info
        _log_end(
            "%s END %dms stage=1 j=%s conf=%.2f blocks=%d",
            lp, total_ms, parsed["judgment"], parsed["confidence"],
            len(parsed.get("blocks", []) + tool_results),
        )
        pipeline_metrics.record(
            pipeline_type=pt, stage=1, latency_ms=total_ms,
            judgment=parsed["judgment"], escalated=False,
            stage1_ms=stage1_ms,
        )
        return PipelineOutput(
            judgment=parsed["judgment"], confidence=parsed["confidence"],
            message=parsed["message"],
            blocks=parsed.get("blocks", []) + tool_results,
            escalated=False, source="fast", pipeline_type=pt,
        )

    # === Stage 2: Deep ===
    reason = parsed.get("escalation_reason", "")
    logger.info("%s → ESCALATE reason='%s'", lp, reason[:60])

    # session あり: Stage 1 即返し、Stage 2 はバックグラウンド (次の judge で配信)
    if session is not None and session_store is not None:
        total_ms = _ms(t_start)
        logger.info("%s END %dms stage=1(bg_escalate) msg='%s'", lp, total_ms, parsed["message"][:50])
        pipeline_metrics.record(
            pipeline_type=pt, stage=1, latency_ms=total_ms,
            judgment=parsed["judgment"], escalated=True, stage1_ms=stage1_ms,
        )
        # バックグラウンドで Stage 2 実行 → pending:{session_id} に書き込む
        asyncio.get_event_loop().create_task(
            _run_stage2_background(
                input_data, reason, guide_service, hq_client,
                rag_client, embedding_client,
                session.session_id, session_store, lp,
            )
        )
        return PipelineOutput(
            judgment=parsed["judgment"], confidence=parsed["confidence"],
            message=parsed.get("message", "少し調べますね。"),
            blocks=parsed.get("blocks", []) + tool_results,
            escalated=True, source="fast", pipeline_type=pt,
        )

    # periodic (または session なし): 同期で Stage 2 実行
    t2 = time.monotonic()
    with tracer.start_as_current_span("pipeline.stage2") as s2_span:
        s2_span.set_attribute("stage2.escalation_reason", reason[:100])
        try:
            stage2_prompt = _build_stage2_prompt(input_data, reason, guide_service)
            hq_tools = build_hq_tools(
                rag_client=rag_client, embedding_client=embedding_client,
                plan_steps_ref=list(input_data.plan_steps or []),
                plan_source_id=input_data.plan_source_id,
            )

            text2, tool_results2 = await hq_client.call_with_tools(
                system_prompt=stage2_prompt, tools=hq_tools,
                image_bytes=input_data.image_bytes, max_rounds=5,
            )

            parsed2 = _parse_response(text2)
            all_blocks = parsed2.get("blocks", []) + tool_results2
            stage2_ms = _ms(t2)
            total_ms = _ms(t_start)

            s2_span.set_attributes({
                "stage2.latency_ms": stage2_ms,
                "stage2.judgment": parsed2["judgment"],
                "stage2.tools": len(tool_results2),
                "stage2.blocks": len(all_blocks),
            })
            span.set_attributes({
                "pipeline.final_stage": 2,
                "pipeline.total_ms": total_ms,
                "pipeline.judgment": parsed2["judgment"],
                "pipeline.escalated": True,
            })
            logger.info(
                "%s stage2 %dms j=%s tools=%d blocks=%d msg='%s'",
                lp, stage2_ms, parsed2["judgment"], len(tool_results2),
                len(all_blocks), parsed2["message"][:50],
            )
            logger.info(
                "%s END %dms stage=1+2 (s1=%dms s2=%dms)",
                lp, total_ms, stage1_ms, stage2_ms,
            )
            pipeline_metrics.record(
                pipeline_type=pt, stage=2, latency_ms=total_ms,
                judgment=parsed2["judgment"], escalated=True,
                stage1_ms=stage1_ms, stage2_ms=stage2_ms,
            )
            return PipelineOutput(
                judgment=parsed2["judgment"], confidence=parsed2["confidence"],
                message=parsed2["message"], blocks=all_blocks,
                escalated=True, source="deep", pipeline_type=pt,
            )

        except Exception as e:
            stage2_ms = _ms(t2)
            total_ms = _ms(t_start)
            s2_span.set_status(trace.StatusCode.ERROR, str(e))
            logger.warning(
                "%s stage2 FAIL %dms %s (falling back to stage1)", lp, stage2_ms, e,
            )
            logger.info("%s END %dms stage=1+2(fallback)", lp, total_ms)
            pipeline_metrics.record_error()
            pipeline_metrics.record(
                pipeline_type=pt, stage=2, latency_ms=total_ms,
                judgment=parsed["judgment"], escalated=True,
                stage1_ms=stage1_ms, stage2_ms=stage2_ms,
            )
            return PipelineOutput(
                judgment=parsed["judgment"], confidence=parsed["confidence"],
                message=parsed.get("message", "高精度判定に失敗しました"),
                blocks=parsed.get("blocks", []),
                escalated=True, source="deep", pipeline_type=pt,
            )


# === プロンプト構築 ===


def _step_index(input_data: PipelineInput) -> int:
    return (input_data.current_step.step_number - 1) if input_data.current_step else 0


def _build_stage1_prompt(input_data: PipelineInput, guide_service: GuideService) -> str:
    idx = _step_index(input_data)
    if input_data.pipeline_type == "periodic":
        return guide_service.build_judgment_prompt(
            current_step=input_data.current_step,
            next_step=input_data.next_step,
            recent_observations=input_data.recent_observations,
            current_step_index=idx,
            total_steps=input_data.total_steps,
        )
    elif input_data.current_step:
        # プランモード: ステップ情報あり
        return guide_service.build_user_action_prompt(
            user_message=input_data.user_message or "",
            current_step=input_data.current_step,
            next_step=input_data.next_step,
            recent_observations=input_data.recent_observations,
            current_step_index=idx,
            total_steps=input_data.total_steps,
            chat_history=input_data.chat_history,
        )
    else:
        # 探索モード: プランなし
        return guide_service.build_explore_prompt(
            user_message=input_data.user_message or "",
            chat_history=input_data.chat_history,
        )


async def _run_stage2_background(
    input_data: PipelineInput,
    escalation_reason: str,
    guide_service: GuideService,
    hq_client: LLMClient,
    rag_client,
    embedding_client,
    session_id: str,
    session_store,  # ValkeySessionStore
    lp: str,
) -> None:
    """バックグラウンドで Stage 2 を実行し、結果を pending:{session_id} に書き込む。

    session 本体には触らない (race condition 回避)。
    """
    t0 = time.monotonic()
    try:
        prompt = _build_stage2_prompt(input_data, escalation_reason, guide_service)
        hq_tools = build_hq_tools(
            rag_client=rag_client, embedding_client=embedding_client,
            plan_steps_ref=list(input_data.plan_steps or []),
            plan_source_id=input_data.plan_source_id,
        )
        text, tool_results = await hq_client.call_with_tools(
            system_prompt=prompt, tools=hq_tools,
            image_bytes=input_data.image_bytes, max_rounds=5,
        )
        parsed = _parse_response(text)
        all_blocks = parsed.get("blocks", []) + tool_results
        elapsed = _ms(t0)

        # pending 専用キーに書き込み (session 本体と独立、アトミック)
        await session_store.set_pending(
            session_id, parsed.get("message", ""), all_blocks,
        )

        logger.info(
            "%s stage2(bg) %dms tools=%d blocks=%d msg='%s'",
            lp, elapsed, len(tool_results), len(all_blocks), parsed.get("message", "")[:50],
        )
        pipeline_metrics.record(
            pipeline_type=input_data.pipeline_type, stage=2, latency_ms=elapsed,
            judgment=parsed.get("judgment", "continue"), escalated=True,
            stage2_ms=elapsed,
        )

    except Exception as e:
        elapsed = _ms(t0)
        logger.warning("%s stage2(bg) FAIL %dms: %s", lp, elapsed, e)
        pipeline_metrics.record_error()
        # エラー時もユーザーに通知 (pending にエラーメッセージを書く)
        try:
            await session_store.set_pending(
                session_id,
                "すみません、詳しく調べられませんでした。もう一度お試しください。",
                [{"type": "alert", "message": "処理に失敗しました", "severity": "warning"}],
            )
        except Exception:
            pass  # pending 書き込みも失敗したら諦める


def _build_stage2_prompt(
    input_data: PipelineInput, escalation_reason: str, guide_service: GuideService,
) -> str:
    idx = _step_index(input_data)
    return guide_service.build_stage2_prompt(
        escalation_reason=escalation_reason,
        current_step=input_data.current_step,
        next_step=input_data.next_step,
        user_message=input_data.user_message,
        recent_observations=input_data.recent_observations,
        current_step_index=idx,
        total_steps=input_data.total_steps,
        chat_history=input_data.chat_history,
    )
