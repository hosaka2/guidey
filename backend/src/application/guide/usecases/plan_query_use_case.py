"""プラン取得ユースケース.

業務ロジック: SQLite からプランを読み込み、既存 session_id に plan_steps を注入する。
session_id は /session/start で採番済み前提。
生成プラン (goal → 動的生成) は SQLite 非永続のため、GET 時は session state から復元する。
"""

import logging

from src.application.guide.schemas.api import PlanResponse, PlanStepResponse
from src.application.guide.usecases.plan_use_case import PlanGenerateUseCase
from src.common.exceptions import SessionError
from src.config import settings
from src.domain.guide.model import PlanStep
from src.infrastructure.agent.agent import AgentClient
from src.infrastructure.repositories.plan_repository import get_plan_title, load_plan

logger = logging.getLogger(__name__)


class PlanQueryUseCase:
    """プラン取得 + 既存 session への plan_steps 注入。"""

    def __init__(self, agent: AgentClient):
        self._agent = agent

    async def get(self, *, source_id: str, session_id: str) -> PlanResponse:
        """既存プラン取得 + 既存 session に plan_steps 注入。

        流れ:
          1. SQLite から読む (事前定義プラン)
          2. SQLite に無ければ session state から復元 (生成プラン)
          3. どちらにも無ければ 404
        """
        steps = load_plan(source_id, settings.static_dir)
        if steps:
            title = get_plan_title(source_id, settings.static_dir)
            await self._agent.inject_plan_steps(
                session_id=session_id,
                plan_source_id=source_id,
                plan_steps=steps,
                plan_title=title,
            )
            return _build_response(
                source_id=source_id,
                title=title,
                session_id=session_id,
                steps=steps,
                frame_url_fn=lambda s: f"/static/manual/{source_id}/{s.frame_path}" if s.frame_path else "",
            )

        # SQLite ミス: session state (生成プラン) から復元
        snapshot = await self._agent.get_plan_snapshot(session_id=session_id)
        if snapshot and snapshot["plan_source_id"] == source_id:
            steps = [
                PlanStep(
                    step_number=s["step_number"],
                    text=s["text"],
                    visual_marker=s.get("visual_marker", ""),
                    frame_path=s.get("frame_path", ""),
                )
                for s in snapshot["plan_steps"]
            ]
            return _build_response(
                source_id=source_id,
                title=snapshot.get("plan_title", ""),
                session_id=session_id,
                # 生成プランは frame_path が既に完全URL (e.g. /static/frames/...) なのでそのまま
                steps=steps,
                frame_url_fn=lambda s: s.frame_path or "",
            )

        raise SessionError(f"プラン '{source_id}' が見つかりません")

    async def generate_and_inject(
        self,
        *,
        goal: str,
        session_id: str,
        generate_uc: PlanGenerateUseCase,
    ) -> PlanResponse:
        """ゴール → プラン生成 → 既存 session に plan_steps 注入。"""
        plan_response, steps = await generate_uc.generate(goal=goal, session_id=session_id)
        await self._agent.inject_plan_steps(
            session_id=session_id,
            plan_source_id=plan_response.source_id,
            plan_steps=steps,
            plan_title=plan_response.title,
        )
        return plan_response


def _build_response(
    *,
    source_id: str,
    title: str,
    session_id: str,
    steps,
    frame_url_fn,
) -> PlanResponse:
    return PlanResponse(
        source_id=source_id,
        title=title,
        session_id=session_id,
        steps=[
            PlanStepResponse(
                step_number=s.step_number,
                text=s.text,
                visual_marker=s.visual_marker,
                frame_url=frame_url_fn(s),
            )
            for s in steps
        ],
    )
