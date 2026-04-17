"""ユーザー対話ユースケース (/guide/chat).

業務ロジック: session_id が無い場合は ephemeral セッションを先に作ってから chat 実行。
グラフの操作は AgentClient に委譲。
"""

import logging
from collections.abc import AsyncIterator

from src.infrastructure.agent.agent import AgentClient, StreamEvent

logger = logging.getLogger(__name__)


class ChatUseCase:
    """探索モード (session_id 無し) での ephemeral seed を含むチャット実行。"""

    def __init__(self, agent: AgentClient):
        self._agent = agent

    async def astream(
        self,
        *,
        user_message: str,
        session_id: str = "",
        image_bytes: bytes | None = None,
        stage1_result_json: str = "",
    ) -> AsyncIterator[StreamEvent]:
        # session_id 未指定 → ephemeral セッションを seed して使い捨てる
        # (TTL で自動揮発、履歴は残らない)
        if not session_id:
            session_id = await self._agent.seed_session(plan_source_id="explore")

        async for event in self._agent.run_chat(
            session_id=session_id,
            user_message=user_message,
            image_bytes=image_bytes,
            stage1_result_json=stage1_result_json,
        ):
            yield event
