"""プラン取得ユースケース.

業務ロジック: プランを (memory cache / SQLite / generated cache から) 読み込み、
その plan_steps で新セッションを seed して session_id を返す。
"""

import logging

from src.application.guide import plan_cache
from src.application.guide.plan_use_case import PlanGenerateUseCase
from src.application.guide.schemas import PlanResponse, PlanStepResponse
from src.common.exceptions import SessionError
from src.config import settings
from src.infrastructure.agent.agent import AgentClient
from src.infrastructure.repositories.plan_repository import get_plan_title, load_plan

logger = logging.getLogger(__name__)


class PlanQueryUseCase:
    """プラン取得 + セッション初期化。"""

    def __init__(self, agent: AgentClient):
        self._agent = agent

    async def get(self, source_id: str) -> PlanResponse:
        """既存プラン取得 (メモリキャッシュ優先、次いで SQLite)。404 あり。"""
        cached = plan_cache.get_by_source_id(source_id)
        if cached:
            steps_raw = (
                plan_cache.get_generated_steps(source_id)
                or load_plan(source_id, settings.static_dir)
                or []
            )
            cached.session_id = await self._agent.seed_session_from_plan_steps(
                plan_source_id=source_id, plan_steps=steps_raw,
            )
            return cached

        steps = load_plan(source_id, settings.static_dir)
        if not steps:
            raise SessionError(f"プラン '{source_id}' が見つかりません")
        title = get_plan_title(source_id, settings.static_dir)

        session_id = await self._agent.seed_session_from_plan_steps(
            plan_source_id=source_id, plan_steps=steps,
        )
        return PlanResponse(
            source_id=source_id,
            title=title,
            session_id=session_id,
            steps=[
                PlanStepResponse(
                    step_number=s.step_number, text=s.text,
                    visual_marker=s.visual_marker,
                    frame_url=(
                        f"/static/manual/{source_id}/{s.frame_path}"
                        if s.frame_path else ""
                    ),
                )
                for s in steps
            ],
        )

    async def generate_and_seed(
        self, *, goal: str, generate_uc: PlanGenerateUseCase,
    ) -> PlanResponse:
        """ゴール → プラン生成 (既存 UseCase に委譲) → セッション seed。"""
        plan_response = await generate_uc.generate(goal=goal)
        steps = plan_cache.get_generated_steps(plan_response.source_id) or []
        plan_response.session_id = await self._agent.seed_session_from_plan_steps(
            plan_source_id=plan_response.source_id, plan_steps=steps,
        )
        return plan_response
