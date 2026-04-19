"""セッション管理ユースケース (/guide/session/start).

探索モード・プランモード共通の唯一のセッション採番ポイント。
pass-through だが、拡張ポイント (認可・ユーザー紐付け等) として残す。
"""

from src.infrastructure.agent.agent import AgentClient


class SessionUseCase:
    def __init__(self, agent: AgentClient):
        self._agent = agent

    async def start(self) -> str:
        """空 state で新セッションを採番。plan_steps はモード選択後に注入される。"""
        return await self._agent.seed_session()
