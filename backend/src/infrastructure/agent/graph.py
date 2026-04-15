"""LangGraph State Machine: 2段階LLM + UIブロック + Tool Calling.

Observe → Appraise → think_fast → [can_handle?]
                                    ├─ Yes → safety_check → act → END
                                    └─ No → think_deep → safety_check → act → END
"""

import logging
from datetime import datetime
from typing import Any, Literal, TypedDict

import numpy as np
from langgraph.graph import END, StateGraph

from src.common.json_utils import extract_json_object
from src.application.guide.blocks import AlertBlock
from src.domain.guide.model import PlanStep, check_step_safety
from src.domain.guide.service import GuideService
from src.infrastructure.agent.tools import build_hq_tools
from src.infrastructure.llm.base import LLMClient
from src.infrastructure.rag.embeddings import EmbeddingClient

logger = logging.getLogger(__name__)


class GuideState(TypedDict, total=False):
    """自律エージェントの共有State."""

    # --- 入力 ---
    image_bytes: bytes
    current_step_index: int
    plan_steps: list[PlanStep]

    # --- 短期メモリ ---
    recent_observations: list[str]

    # --- 中期メモリ ---
    completed_steps: list[dict]
    step_started_at: str

    # --- 変化検知 ---
    has_change: bool
    last_caption: str
    last_caption_embedding: list[float]

    # --- 2段階LLM ---
    can_handle: bool  # Gemma が処理できたか
    escalation_reason: str  # HQ に渡す理由
    escalated: bool  # HQ で処理されたか

    # --- UIブロック ---
    blocks: list[dict]  # Block の dict リスト

    # --- ハーネス ---
    safety_override: str
    safety_reason: str

    # --- モード ---
    is_calibration: bool

    # --- 出力 ---
    judgment: str
    confidence: float
    message: str


# === 安全確認ルール ===
# 安全ルールは domain (model.py の check_step_safety) に定義


# === ノード ===
def observe(state: GuideState) -> dict[str, Any]:
    if not state.get("step_started_at"):
        return {"has_change": True, "step_started_at": datetime.now().isoformat()}
    return {"has_change": True}


CHANGE_THRESHOLD = 0.90


def _cosine_sim(a: list[float], b: list[float]) -> float:
    va, vb = np.array(a), np.array(b)
    norm = np.linalg.norm(va) * np.linalg.norm(vb)
    return float(np.dot(va, vb) / norm) if norm > 0 else 0.0


async def appraise(
    state: GuideState, llm_client: LLMClient, embedding_client: EmbeddingClient | None
) -> dict[str, Any]:
    """意味的変化検知."""
    if not embedding_client:
        return {"has_change": True}
    try:
        caption = await llm_client.analyze_image(
            state["image_bytes"], "この画像の内容を1文で簡潔に説明してください。回答のみ。"
        )
        caption = caption.strip()
    except Exception:
        return {"has_change": True}

    last_emb = state.get("last_caption_embedding")
    try:
        emb = await embedding_client.embed_query(caption)
    except Exception:
        return {"has_change": True, "last_caption": caption}

    if not last_emb:
        return {"has_change": True, "last_caption": caption, "last_caption_embedding": emb}

    sim = _cosine_sim(emb, last_emb)
    changed = sim < CHANGE_THRESHOLD
    logger.info(f"[Appraise] sim={sim:.3f} changed={changed}")
    return {"has_change": changed, "last_caption": caption, "last_caption_embedding": emb}


def _get_current_and_next(state: GuideState) -> tuple[PlanStep | None, PlanStep | None]:
    """現在と次のステップを取得。"""
    steps = state["plan_steps"]
    idx = state["current_step_index"]
    current = steps[idx] if 0 <= idx < len(steps) else None
    nxt = steps[idx + 1] if idx + 1 < len(steps) else None
    return current, nxt


def _parse_llm_response(raw: str) -> dict[str, Any]:
    """LLM出力を統一パーサーでパース。"""
    defaults = {
        "judgment": "continue", "confidence": 0.5, "message": "",
        "can_handle": True, "escalation_reason": "", "blocks": [],
    }
    data = extract_json_object(raw)
    if not data:
        return defaults

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


# --- Gemma (高速) ---

# (tool calling / UIブロック生成は /guide/chat エンドポイントで処理)


async def think_fast(
    state: GuideState, guide_service: GuideService, llm_client: LLMClient
) -> dict[str, Any]:
    """自律監視: Gemma で高速3択判定。シンプル、tool calling なし。"""
    current, nxt = _get_current_and_next(state)
    if not current:
        return {"judgment": "anomaly", "confidence": 0.0, "message": "ステップ不明",
                "can_handle": True, "blocks": []}

    if state.get("is_calibration"):
        return await _calibrate(state, state["plan_steps"], guide_service, llm_client)

    prompt = guide_service.build_judgment_prompt(
        current_step=current, next_step=nxt,
        recent_observations=state.get("recent_observations"),
    )

    logger.info("[think_fast] step=%d obs=%s", state["current_step_index"],
                state.get("recent_observations", [])[-2:])

    raw = await llm_client.analyze_image(state["image_bytes"], prompt)
    parsed = _parse_llm_response(raw)
    logger.info("[think_fast] result: j=%s conf=%.2f msg=%s",
                parsed["judgment"], parsed["confidence"], parsed["message"][:40])
    return parsed


# --- HQ (高品質, tool calling 対応) ---
async def think_deep(
    state: GuideState, guide_service: GuideService, hq_client: LLMClient,
    rag_client=None, embedding_client=None,
) -> dict[str, Any]:
    """HQモデルでエスカレーション処理 + RAG/プラン修正ツール。"""
    current, nxt = _get_current_and_next(state)
    escalation_reason = state.get("escalation_reason", "")

    prompt_parts = [
        "あなたは高精度な作業サポートエージェントです。",
        "1段目の判定が自信なしでエスカレーションされました。",
    ]
    if escalation_reason:
        prompt_parts.append(f"理由: {escalation_reason}")

    if current:
        prompt_parts.append(f"\n現在のステップ (Step {current.step_number}): {current.text}")
        if current.visual_marker:
            prompt_parts.append(f"完了の目印: {current.visual_marker}")
    if nxt:
        prompt_parts.append(f"次のステップ (Step {nxt.step_number}): {nxt.text}")

    observations = state.get("recent_observations", [])
    if observations:
        prompt_parts.append("\n直近の観察:")
        for obs in observations[-3:]:
            prompt_parts.append(f"- {obs}")

    prompt_parts.extend([
        "",
        "必要に応じてツールを呼び出してください (タイマー、警告、画像表示等)。",
        "最終的にJSON形式で判定を回答:",
        '{"judgment":"continue|next|anomaly","confidence":0.0-1.0,"message":"..."}',
    ])

    prompt = "\n".join(prompt_parts)
    logger.info("[think_deep] escalation_reason=%s", escalation_reason[:50] if escalation_reason else "none")

    # RAG/プラン修正ツール付きで呼び出し
    hq_tools = build_hq_tools(
        rag_client=rag_client,
        embedding_client=embedding_client,
        plan_steps_ref=list(state.get("plan_steps", [])),
    )

    try:
        text, tool_results = await hq_client.call_with_tools(
            system_prompt=prompt, tools=hq_tools,
            image_bytes=state["image_bytes"], max_rounds=5,
        )
        parsed = _parse_llm_response(text)
        if tool_results:
            logger.info("[think_deep] tools called: %s", [r.get("type") for r in tool_results])
            parsed["blocks"] = parsed.get("blocks", []) + tool_results
        parsed["escalated"] = True
        parsed["can_handle"] = True
        logger.info("[think_deep] result: j=%s blocks=%d msg=%s",
                    parsed["judgment"], len(parsed["blocks"]), parsed["message"][:40])
        return parsed
    except Exception as e:
        logger.warning("[think_deep] failed: %s", e)
        return {
            "judgment": "continue", "confidence": 0.3,
            "message": "高精度判定に失敗しました", "escalated": True,
            "can_handle": True, "blocks": [],
        }


# --- Safety / Act (既存ベース) ---


def safety_check(state: GuideState) -> dict[str, Any]:
    steps = state.get("plan_steps", [])
    idx = state.get("current_step_index", 0)
    judgment = state.get("judgment", "continue")
    blocks = list(state.get("blocks", []))

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

    if judgment == "anomaly" and state.get("confidence", 1.0) < 0.5:
        return {
            "safety_override": "block",
            "judgment": "continue",
            "message": "確信度が低いため、もう少し様子を見ます",
        }

    return {"safety_override": "none", "safety_reason": ""}


def act(state: GuideState) -> dict[str, Any]:
    judgment = state.get("judgment", "continue")
    step_idx = state.get("current_step_index", 0)

    logger.info(
        "[Agent] judgment=%s conf=%.2f step=%d escalated=%s blocks=%d msg=%s",
        judgment, state.get("confidence", 0), step_idx,
        state.get("escalated", False), len(state.get("blocks", [])),
        state.get("message", "")[:50],
    )

    updates: dict[str, Any] = {}
    if judgment == "next" and state.get("step_started_at"):
        try:
            dur = (datetime.now() - datetime.fromisoformat(state["step_started_at"])).total_seconds()
        except (ValueError, TypeError):
            dur = 0
        completed = list(state.get("completed_steps", []))
        completed.append({"step_number": step_idx + 1, "completed_at": datetime.now().isoformat(),
                          "duration_sec": round(dur)})
        updates["completed_steps"] = completed
        updates["step_started_at"] = datetime.now().isoformat()

    return updates


# --- キャリブレーション ---


async def _calibrate(state, steps, guide_service, llm_client):
    steps_desc = "\n".join(f"Step {s.step_number}: {s.text}" for s in steps)
    prompt = (
        f"以下のステップリストがあります:\n{steps_desc}\n\n"
        "カメラの画像を見て、現在どのステップにいるか判定。\n"
        '回答: {{"step_number": 数字, "confidence": 0.0-1.0, "message": "説明"}}'
    )
    import re as _re
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
            "can_handle": True, "blocks": []}


# --- 条件分岐 ---


def should_think(state: GuideState) -> Literal["think_fast", "skip"]:
    return "think_fast" if state.get("has_change", True) else "skip"


def should_escalate(state: GuideState) -> Literal["think_deep", "safety_check"]:
    return "think_deep" if not state.get("can_handle", True) else "safety_check"


# === グラフ構築 ===


def build_guide_graph(
    guide_service: GuideService,
    llm_client: LLMClient,
    embedding_client: EmbeddingClient | None = None,
    hq_client: LLMClient | None = None,
    rag_client=None,
) -> StateGraph:
    """2段階LLMの自律エージェントグラフ."""

    _hq = hq_client or llm_client

    async def appraise_node(state: GuideState) -> dict[str, Any]:
        return await appraise(state, llm_client, embedding_client)

    async def think_fast_node(state: GuideState) -> dict[str, Any]:
        return await think_fast(state, guide_service, llm_client)

    async def think_deep_node(state: GuideState) -> dict[str, Any]:
        return await think_deep(state, guide_service, _hq, rag_client, embedding_client)

    graph = StateGraph(GuideState)

    graph.add_node("observe", observe)
    graph.add_node("appraise", appraise_node)
    graph.add_node("think_fast", think_fast_node)
    graph.add_node("think_deep", think_deep_node)
    graph.add_node("safety_check", safety_check)
    graph.add_node("act", act)

    graph.set_entry_point("observe")
    graph.add_edge("observe", "appraise")
    graph.add_conditional_edges("appraise", should_think,
                                {"think_fast": "think_fast", "skip": END})
    graph.add_conditional_edges("think_fast", should_escalate,
                                {"think_deep": "think_deep", "safety_check": "safety_check"})
    graph.add_edge("think_deep", "safety_check")
    graph.add_edge("safety_check", "act")
    graph.add_edge("act", END)

    return graph
