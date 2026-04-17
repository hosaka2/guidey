"""セッション管理ユースケース (/guide/session/start).

pass-through だが、拡張ポイント (認可・ユーザー紐付け・プラン制約等) として残す。
"""

from src.infrastructure.agent.agent import AgentClient


class SessionUseCase:
    def __init__(self, agent: AgentClient):
        self._agent = agent

    async def start_explore(self) -> str:
        """探索モード: プランなしで空 state を seed。"""
        return await self._agent.seed_session(plan_source_id="explore")
