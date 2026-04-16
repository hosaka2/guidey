"""LangGraph State Machine: 統一2段階パイプライン.

Observe → Appraise → [変化あり?]
                       ├─ No → END
                       └─ Yes → think (pipeline) → safety_check → act → END

think ノードは pipeline.run_two_stage_pipeline を呼び出す。
エスカレーション判定はパイプライン内部で処理。
"""

import logging
import re as _re
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph

from src.common.json_utils import extract_json_object
from src.application.guide.blocks import AlertBlock
from src.domain.guide.model import PlanStep, check_step_safety
from src.domain.guide.service import GuideService
from src.infrastructure.agent.pipeline import PipelineInput, PipelineOutput, run_two_stage_pipeline
from src.infrastructure.llm.base import LLMClient
from src.infrastructure.rag.embeddings import EmbeddingClient

logger = logging.getLogger(__name__)


class GuideState(TypedDict, total=False):
    """自律エージェントの共有State."""

    # --- 入力 ---
    image_bytes: bytes
    current_step_index: int
    total_steps: int
    plan_steps: list[PlanStep]
    plan_source_id: str

    # --- 短期メモリ ---
    recent_observations: list[str]

    # --- 滞在時間 (Mobile管理、リクエストで受け取る) ---
    current_step_duration_sec: int

    # --- パイプライン出力 ---
    escalated: bool
    blocks: list[dict]

    # --- ハーネス ---
    safety_override: str
    safety_reason: str

    # --- 非同期キュー (Stage 2 バックグラウンド結果) ---
    pending_message: str
    pending_blocks: list[dict]

    # --- モード ---
    is_calibration: bool

    # --- 出力 ---
    judgment: str
    confidence: float
    message: str


# === ノード ===


def drain_pending(state: GuideState) -> dict[str, Any]:
    """キューに Stage 2 バックグラウンド結果があれば取り出す。"""
    pending_msg = state.get("pending_message", "")
    pending_blocks = state.get("pending_blocks", [])
    if pending_msg or pending_blocks:
        logger.info("[drain] pending found: msg='%s' blocks=%d", pending_msg[:40], len(pending_blocks))
        return {
            "judgment": "continue",
            "confidence": 1.0,
            "message": pending_msg,
            "blocks": pending_blocks,
            "pending_message": "",
            "pending_blocks": [],
        }
    return {}


def _get_current_and_next(state: GuideState) -> tuple[PlanStep | None, PlanStep | None]:
    steps = state["plan_steps"]
    idx = state["current_step_index"]
    current = steps[idx] if 0 <= idx < len(steps) else None
    nxt = steps[idx + 1] if idx + 1 < len(steps) else None
    return current, nxt


async def think(
    state: GuideState,
    guide_service: GuideService,
    llm_client: LLMClient,
    hq_client: LLMClient | None = None,
    rag_client=None,
    embedding_client: EmbeddingClient | None = None,
    session=None,
    session_store=None,
) -> dict[str, Any]:
    """統一パイプラインで判定 (periodic)."""
    current, nxt = _get_current_and_next(state)
    if not current:
        return {"judgment": "anomaly", "confidence": 0.0, "message": "ステップ不明",
                "blocks": []}

    if state.get("is_calibration"):
        return await _calibrate(state, state["plan_steps"], guide_service, llm_client)

    pipeline_input = PipelineInput(
        pipeline_type="periodic",
        image_bytes=state.get("image_bytes"),
        current_step=current,
        next_step=nxt,
        recent_observations=state.get("recent_observations", []),
        plan_steps=state.get("plan_steps"),
        plan_source_id=state.get("plan_source_id", ""),
        total_steps=state.get("total_steps", 0),
    )

    result: PipelineOutput = await run_two_stage_pipeline(
        input_data=pipeline_input,
        guide_service=guide_service,
        llm_client=llm_client,
        hq_client=hq_client,
        rag_client=rag_client,
        embedding_client=embedding_client,
        session=session,
        session_store=session_store,
    )

    return {
        "judgment": result.judgment,
        "confidence": result.confidence,
        "message": result.message,
        "blocks": result.blocks,
        "escalated": result.escalated,
    }


# --- Safety / Act ---


def safety_check(state: GuideState) -> dict[str, Any]:
    """安全チェック.

    1. 次ステップの危険キーワード検知 → AlertBlock + 確認要求
    2. 最終ステップ超え防止
    3. 低確信度 anomaly のブロック → continue にダウングレード
    4. 最低滞在時間ガード → 現ステップに15秒未満なら next ブロック
    """
    steps = state.get("plan_steps", [])
    idx = state.get("current_step_index", 0)
    judgment = state.get("judgment", "continue")
    blocks = list(state.get("blocks", []))

    # --- 1. 次ステップの安全キーワード検知 ---
    if judgment == "next":
        next_idx = idx + 1
        if next_idx < len(steps):
            override, warning = check_step_safety(steps[next_idx])
            if override != "none":
                blocks.append(AlertBlock(message=warning, severity="warning").model_dump())
                return {
                    "safety_override": override,
                    "safety_reason": warning,
                    "message": f"{state.get('message', '')} ⚠️ {warning}",
                    "blocks": blocks,
                }
        # 最終ステップ超え防止
        if next_idx >= len(steps):
            logger.info("[safety] next blocked: already at last step (%d/%d)", idx + 1, len(steps))
            return {
                "safety_override": "block",
                "judgment": "continue",
                "message": "最後のステップです",
            }

    # --- 2. 低確信度 anomaly のブロック ---
    if judgment == "anomaly" and state.get("confidence", 1.0) < 0.5:
        logger.info("[safety] anomaly blocked: low confidence %.2f", state.get("confidence", 0))
        return {
            "safety_override": "block",
            "judgment": "continue",
            "message": "確信度が低いため、もう少し様子を見ます",
        }

    # --- 3. 最低滞在時間ガード ---
    # 現在のステップに十分な時間いないと next を許可しない
    MIN_STEP_DURATION_SEC = 15
    duration = state.get("current_step_duration_sec", 999)
    if judgment == "next" and duration < MIN_STEP_DURATION_SEC:
        logger.info(
            "[safety] next blocked: current step only %ds (min %ds)",
            duration, MIN_STEP_DURATION_SEC,
        )
        return {
            "safety_override": "block",
            "judgment": "continue",
            "message": "",
        }

    return {"safety_override": "none", "safety_reason": ""}


def act(state: GuideState) -> dict[str, Any]:
    """ログ出力のみ。completed_steps はMobile側で管理。"""
    j = state.get("judgment", "continue")
    _log = logger.debug if j == "continue" else logger.info
    _log(
        "[Agent] judgment=%s conf=%.2f step=%d escalated=%s blocks=%d msg=%s",
        j, state.get("confidence", 0), state.get("current_step_index", 0),
        state.get("escalated", False), len(state.get("blocks", [])),
        state.get("message", "")[:50],
    )
    return {}


# --- キャリブレーション ---


async def _calibrate(state, steps, guide_service, llm_client):
    prompt = guide_service.build_calibration_prompt(steps)
    raw = await llm_client.analyze_image(state["image_bytes"], prompt)
    data = extract_json_object(raw)
    if data:
        sn = int(data.get("step_number", 1))
        c = float(data.get("confidence", 0.5))
        msg = str(data.get("message", ""))
    else:
        m = _re.search(r'"step_number"\s*:\s*(\d+)', raw)
        sn = int(m.group(1)) if m else 1
        c, msg = 0.5, "キャリブレーション完了"
    idx = max(0, min(sn - 1, len(steps) - 1))
    return {"judgment": "calibrated", "confidence": c,
            "message": f"Step {idx+1} から開始: {msg}", "current_step_index": idx,
            "blocks": []}


# === グラフ構築 ===


def _should_skip_think(state: GuideState) -> str:
    """pending があれば think をスキップ。"""
    if state.get("message") or state.get("blocks"):
        return "act"  # drain_pending が結果をセット済み → 直接 act
    return "think"


def build_guide_graph(
    guide_service: GuideService,
    llm_client: LLMClient,
    embedding_client: EmbeddingClient | None = None,
    hq_client: LLMClient | None = None,
    rag_client=None,
    session=None,
    session_store=None,
) -> StateGraph:
    """自律エージェントグラフ.

    drain_pending → [pending?]
      ├─ あり → act → END (LLM呼ばない、pending結果を即返し)
      └─ なし → think (pipeline) → safety_check → act → END
    """
    async def think_node(state: GuideState) -> dict[str, Any]:
        return await think(
            state, guide_service, llm_client, hq_client, rag_client, embedding_client,
            session=session, session_store=session_store,
        )

    graph = StateGraph(GuideState)

    graph.add_node("drain_pending", drain_pending)
    graph.add_node("think", think_node)
    graph.add_node("safety_check", safety_check)
    graph.add_node("act", act)

    graph.set_entry_point("drain_pending")
    graph.add_conditional_edges("drain_pending", _should_skip_think,
                                {"act": "act", "think": "think"})
    graph.add_edge("think", "safety_check")
    graph.add_edge("safety_check", "act")
    graph.add_edge("act", END)

    return graph
