"""AgentClient: LangGraph 実行のクライアント (インフラ層).

LLMClient がモデル API のクライアントであるのと同じく、これは Agent (Graph) API のクライアント。
graph のライフサイクル (seed / run_periodic / run_chat) を一手に持ち、
UseCase (application 層) に LangGraph の詳細 (astream の stream_mode / configurable のキー /
checkpointer) を露出しない。
"""

import logging
import uuid
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

from langgraph.graph.state import CompiledStateGraph

from src.application.guide.outputs import Stage1Output
from src.common.exceptions import ValidationError

logger = logging.getLogger(__name__)

# (event_name, data) ストリームの型エイリアス
StreamEvent = tuple[str, dict]


def _plan_steps_to_dicts(steps) -> list[dict]:
    """PlanStep (domain) → state 永続化用 dict。JSON-safe。"""
    return [
        {
            "step_number": s.step_number, "text": s.text,
            "visual_marker": s.visual_marker,
            "frame_path": getattr(s, "frame_path", ""),
        }
        for s in steps
    ]


def _parse_stage1_json(raw: str) -> dict | None:
    """クライアント持ち込みの Stage1Output JSON を検証して dict 化。不正なら ValidationError。"""
    if not raw:
        return None
    try:
        return Stage1Output.model_validate_json(raw).model_dump()
    except Exception as e:
        raise ValidationError(f"stage1_result 形式不正: {e}")


class AgentClient:
    """Graph を保持し、seed / run を提供する。"""

    def __init__(self, graph: CompiledStateGraph):
        self._graph = graph

    # ------------------------------------------------------------------
    # セッション初期化
    # ------------------------------------------------------------------

    async def seed_session(
        self, *, plan_source_id: str, plan_steps: list[dict] | None = None,
        session_id: str | None = None,
    ) -> str:
        """新セッションを作成し、初期 state を checkpointer に書き込む。

        pipeline_type は per-call (config 経由) なので seed しない。
        戻り値: session_id (= thread_id)。
        """
        session_id = session_id or str(uuid.uuid4())
        config = {"configurable": {"thread_id": session_id}}
        initial: dict[str, Any] = {
            "plan_steps": plan_steps or [],
            "plan_source_id": plan_source_id,
            "total_steps": len(plan_steps) if plan_steps else 0,
            "current_step_index": 0,
            "step_started_at": datetime.now().isoformat(),
            "recent_observations": [],
            "chat_history": [],
            "total_calls": 0,
            "stage2_calls": 0,
            "escalated": False,
        }
        await self._graph.aupdate_state(config, initial)
        logger.info(
            "[Agent] session seeded %s plan=%s steps=%d",
            session_id[:8], plan_source_id, len(plan_steps or []),
        )
        return session_id

    async def seed_session_from_plan_steps(
        self, *, plan_source_id: str, plan_steps,
    ) -> str:
        """PlanStep オブジェクトのリスト版 (dict 化してから seed)。"""
        return await self.seed_session(
            plan_source_id=plan_source_id,
            plan_steps=_plan_steps_to_dicts(plan_steps),
        )

    # ------------------------------------------------------------------
    # 実行 (SSE 用ストリーム)
    # ------------------------------------------------------------------

    async def run_periodic(
        self, *, session_id: str, image_bytes: bytes,
        is_calibration: bool = False, stage1_result_json: str = "",
    ) -> AsyncIterator[StreamEvent]:
        """定期監視: pipeline_type=periodic で Graph を stream 実行。

          yields ("stage", {...})  — graph ノードが emit した SSE イベント
          yields ("done",  {...})  — 最後に 1 回、current_step_index 付き
        """
        config = self._build_config(
            session_id=session_id, pipeline_type="periodic",
            image_bytes=image_bytes, user_message=None,
            is_calibration=is_calibration,
            precomputed_stage1=_parse_stage1_json(stage1_result_json),
        )
        async for event in self._astream(config):
            yield event

    async def run_chat(
        self, *, session_id: str, user_message: str,
        image_bytes: bytes | None = None, stage1_result_json: str = "",
    ) -> AsyncIterator[StreamEvent]:
        """ユーザー対話: pipeline_type=user_action で Graph を stream 実行。

        session_id 必須。探索モードは UseCase が事前に seed してから呼ぶ。
        """
        config = self._build_config(
            session_id=session_id, pipeline_type="user_action",
            image_bytes=image_bytes, user_message=user_message,
            is_calibration=False,
            precomputed_stage1=_parse_stage1_json(stage1_result_json),
        )
        async for event in self._astream(config):
            yield event

    # ------------------------------------------------------------------
    # 内部ヘルパ (LangGraph 固有の詳細をここに閉じ込める)
    # ------------------------------------------------------------------

    @staticmethod
    def _build_config(
        *, session_id: str, pipeline_type: str,
        image_bytes: bytes | None, user_message: str | None,
        is_calibration: bool, precomputed_stage1: dict | None,
    ) -> dict:
        """LangGraph RunnableConfig を構築。per-call inputs は全てここに入る。"""
        return {
            "configurable": {
                "thread_id": session_id,
                "pipeline_type": pipeline_type,
                "image_bytes": image_bytes,
                "user_message": user_message,
                "is_calibration": is_calibration,
                "precomputed_stage1": precomputed_stage1,
            },
        }

    async def _astream(self, config: dict) -> AsyncIterator[StreamEvent]:
        """stream_mode=[custom, values] で回して (event, data) タプルに正規化。"""
        final_state: dict | None = None
        async for mode, data in self._graph.astream(
            None, config, stream_mode=["custom", "values"],
        ):
            if mode == "custom":
                yield "stage", data
            elif mode == "values":
                final_state = data  # 最後の yield が最終 state

        idx = (final_state or {}).get("current_step_index", 0)
        yield "done", {"current_step_index": idx}
