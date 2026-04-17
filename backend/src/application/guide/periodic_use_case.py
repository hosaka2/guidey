"""定期監視ユースケース (/guide/periodic).

pass-through だが、「ルータ → UseCase → Client」という層の統一感のため UseCase を通す。
将来、発話抑制ルール・アクセス制御・レート制限など業務ロジックが増えたときの拡張ポイント。
"""

from collections.abc import AsyncIterator

from src.infrastructure.agent.agent import AgentClient, StreamEvent


class PeriodicUseCase:
    def __init__(self, agent: AgentClient):
        self._agent = agent

    async def astream(
        self, *, session_id: str, image_bytes: bytes,
        is_calibration: bool = False, stage1_result_json: str = "",
    ) -> AsyncIterator[StreamEvent]:
        async for event in self._agent.run_periodic(
            session_id=session_id,
            image_bytes=image_bytes,
            is_calibration=is_calibration,
            stage1_result_json=stage1_result_json,
        ):
            yield event
