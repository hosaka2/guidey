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

from langgraph.graph import START
from langgraph.graph.state import CompiledStateGraph

from src.application.guide.schemas.outputs import Stage1Output
from src.common.exceptions import ValidationError

logger = logging.getLogger(__name__)

# (event_name, data) ストリームの型エイリアス
StreamEvent = tuple[str, dict]


def _plan_steps_to_dicts(steps) -> list[dict]:
    """PlanStep (domain) → state 永続化用 dict。JSON-safe。"""
    return [
        {
            "step_number": s.step_number,
            "text": s.text,
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
        raise ValidationError(f"stage1_result 形式不正: {e}") from e


class AgentClient:
    """Graph を保持し、seed / run を提供する。"""

    def __init__(self, graph: CompiledStateGraph):
        self._graph = graph

    # ------------------------------------------------------------------
    # セッション初期化
    # ------------------------------------------------------------------

    async def seed_session(self) -> str:
        """新セッションを作成し、空の初期 state を checkpointer に書き込む。

        /session/start の唯一の呼び出し経路。plan_steps はこの時点では未設定で、
        必要なら別途 inject_plan_steps() で後から注入する。
        pipeline_type は per-call (config 経由) なので seed しない。
        戻り値: session_id (= thread_id)。
        """
        session_id = str(uuid.uuid4())
        config = {"configurable": {"thread_id": session_id}}
        initial: dict[str, Any] = {
            "plan_steps": [],
            "plan_source_id": "",
            "plan_title": "",
            "total_steps": 0,
            "current_step_index": 0,
            "step_started_at": datetime.now().isoformat(),
            "recent_observations": [],
            "chat_history": [],
            "total_calls": 0,
            "stage2_calls": 0,
            "escalated": False,
        }
        await self._graph.aupdate_state(config, initial, as_node=START)
        logger.info("[Agent] session seeded %s", session_id[:8])
        return session_id

    async def sync(
        self,
        *,
        session_id: str,
        current_step_index: int | None,
        new_observations: list[str],
    ) -> dict[str, Any]:
        """エッジ推論経路の state 同期 (LLM 呼び出しなし)。

        モバイルがオンデバイスで stage1 判定を繰り返すと BE の state が古くなる。
        このメソッドで定期的に current_step_index と recent_observations を追い付かせる。

        - current_step_index: 変更あれば上書き + step_started_at 更新
        - new_observations: 末尾 append, MAX_OBSERVATIONS (3) で FIFO 切り詰め

        戻り値: 同期後の state スナップショット (current_step_index, recent_observations, total_steps)。
        """
        config = {"configurable": {"thread_id": session_id}}
        snapshot = await self._graph.aget_state(config)
        state = snapshot.values if snapshot else {}
        if not state:
            raise ValidationError(f"session {session_id[:8]} not found")

        updates: dict[str, Any] = {}
        prev_idx = state.get("current_step_index", 0)
        if current_step_index is not None and current_step_index != prev_idx:
            updates["current_step_index"] = current_step_index
            updates["step_started_at"] = datetime.now().isoformat()

        if new_observations:
            obs = list(state.get("recent_observations", []))
            obs.extend(x for x in new_observations if x)
            # MAX_OBSERVATIONS は graph 側と同じ 3 件
            if len(obs) > 3:
                obs = obs[-3:]
            updates["recent_observations"] = obs

        if updates:
            await self._graph.aupdate_state(config, updates, as_node=START)

        final_idx = updates.get("current_step_index", prev_idx)
        final_obs = updates.get("recent_observations", state.get("recent_observations", []))
        logger.info(
            "[sync] session=%s step=%d→%d obs+=%d (total=%d)",
            session_id[:8],
            prev_idx,
            final_idx,
            len(new_observations),
            len(final_obs),
        )
        return {
            "current_step_index": final_idx,
            "recent_observations": final_obs,
            "total_steps": state.get("total_steps", 0),
        }

    async def inject_plan_steps(
        self,
        *,
        session_id: str,
        plan_source_id: str,
        plan_steps,
        plan_title: str = "",
    ) -> None:
        """既存 session に plan_steps を注入 (上書き)。

        session_id は /session/start で採番済み前提。
        plan_source_id / plan_steps / plan_title / total_steps / current_step_index を上書きし、
        chat_history など他フィールドは保持する。
        """
        config = {"configurable": {"thread_id": session_id}}
        steps_dicts = _plan_steps_to_dicts(plan_steps)
        updates: dict[str, Any] = {
            "plan_steps": steps_dicts,
            "plan_source_id": plan_source_id,
            "plan_title": plan_title,
            "total_steps": len(steps_dicts),
            "current_step_index": 0,
            "step_started_at": datetime.now().isoformat(),
        }
        await self._graph.aupdate_state(config, updates, as_node=START)
        logger.info(
            "[Agent] plan injected session=%s plan=%s steps=%d",
            session_id[:8],
            plan_source_id,
            len(steps_dicts),
        )

    async def get_plan_snapshot(self, *, session_id: str) -> dict | None:
        """Session state から plan 情報を復元する (生成プラン用フォールバック)。

        生成プラン (goal → auto-generated) は SQLite に永続化されないので、
        /plan/{source_id} GET で SQLite ミスのときはここで state から戻す。
        """
        config = {"configurable": {"thread_id": session_id}}
        snapshot = await self._graph.aget_state(config)
        state = snapshot.values if snapshot else {}
        plan_steps = state.get("plan_steps") or []
        if not plan_steps:
            return None
        return {
            "plan_source_id": state.get("plan_source_id", ""),
            "plan_title": state.get("plan_title", ""),
            "plan_steps": plan_steps,
        }

    # ------------------------------------------------------------------
    # 実行 (SSE 用ストリーム)
    # ------------------------------------------------------------------

    async def run_periodic(
        self,
        *,
        session_id: str,
        image_bytes: bytes,
        is_calibration: bool = False,
        stage1_result_json: str = "",
    ) -> AsyncIterator[StreamEvent]:
        """定期監視: pipeline_type=periodic で Graph を stream 実行。

        yields ("stage", {...})  — graph ノードが emit した SSE イベント
        yields ("done",  {...})  — 最後に 1 回、current_step_index 付き
        """
        config = self._build_config(
            session_id=session_id,
            pipeline_type="periodic",
            image_bytes=image_bytes,
            user_message=None,
            is_calibration=is_calibration,
            precomputed_stage1=_parse_stage1_json(stage1_result_json),
        )
        async for event in self._astream(config):
            yield event

    async def run_chat(
        self,
        *,
        session_id: str,
        user_message: str,
        image_bytes: bytes | None = None,
        stage1_result_json: str = "",
    ) -> AsyncIterator[StreamEvent]:
        """ユーザー対話: pipeline_type=user_action で Graph を stream 実行。

        session_id 必須。探索モードは UseCase が事前に seed してから呼ぶ。
        """
        config = self._build_config(
            session_id=session_id,
            pipeline_type="user_action",
            image_bytes=image_bytes,
            user_message=user_message,
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
        *,
        session_id: str,
        pipeline_type: str,
        image_bytes: bytes | None,
        user_message: str | None,
        is_calibration: bool,
        precomputed_stage1: dict | None,
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
        # input={} で毎回 "new run" を指示 (None だと END 状態から resume しようとして空実行)
        async for mode, data in self._graph.astream(
            {},
            config,
            stream_mode=["custom", "values"],
        ):
            if mode == "custom":
                yield "stage", data
            elif mode == "values":
                final_state = data  # 最後の yield が最終 state

        idx = (final_state or {}).get("current_step_index", 0)
        yield "done", {"current_step_index": idx}
