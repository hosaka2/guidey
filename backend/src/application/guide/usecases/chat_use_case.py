"""ユーザー対話ユースケース (/guide/chat).

session_id 必須。呼び出し側 (モバイル) が /session/start で採番した ID を渡す前提。
グラフの操作は AgentClient に委譲。
"""

import logging
from collections.abc import AsyncIterator

from src.infrastructure.agent.agent import AgentClient, StreamEvent

logger = logging.getLogger(__name__)


class ChatUseCase:
    def __init__(self, agent: AgentClient):
        self._agent = agent

    async def astream(
        self,
        *,
        session_id: str,
        user_message: str,
        image_bytes: bytes | None = None,
        stage1_result_json: str = "",
    ) -> AsyncIterator[StreamEvent]:
        async for event in self._agent.run_chat(
            session_id=session_id,
            user_message=user_message,
            image_bytes=image_bytes,
            stage1_result_json=stage1_result_json,
        ):
            yield event
