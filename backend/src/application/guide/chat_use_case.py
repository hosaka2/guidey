"""ユーザー対話ユースケース (/guide/chat).

統一2段階パイプラインを user_action モードで呼び出す。
コンテキストは Session から取得。
"""

import logging

from src.domain.guide.model import PlanStep
from src.domain.guide.service import GuideService
from src.infrastructure.agent.pipeline import PipelineInput, run_two_stage_pipeline
from src.infrastructure.llm.base import LLMClient
from src.infrastructure.rag.embeddings import EmbeddingClient
from src.infrastructure.rag.milvus import MilvusRAGClient
from src.infrastructure.session.models import Session

logger = logging.getLogger(__name__)


class ChatUseCase:
    def __init__(
        self,
        guide_service: GuideService,
        llm_client: LLMClient,
        hq_client: LLMClient | None = None,
        rag_client: MilvusRAGClient | None = None,
        embedding_client: EmbeddingClient | None = None,
        session_store=None,
    ):
        self._guide_service = guide_service
        self._llm = llm_client
        self._hq = hq_client or llm_client
        self._rag = rag_client
        self._emb = embedding_client
        self._session_store = session_store

    async def chat(
        self,
        user_message: str,
        image_bytes: bytes | None = None,
        session: Session | None = None,
    ) -> dict:
        """ユーザー発話に応答。戻り値: {message, blocks, escalated}"""

        # session からコンテキストを取得
        current_step = None
        next_step = None
        plan_steps = None
        total_steps = 0
        recent_observations: list[str] = []
        chat_history: list[dict] = []

        if session:
            steps = [PlanStep(**s) for s in session.plan_steps]
            plan_steps = steps
            total_steps = session.total_steps
            recent_observations = session.recent_observations
            chat_history = session.chat_history
            cs = session.get_current_step()
            if cs:
                current_step = PlanStep(**cs)
            ns = session.get_next_step()
            if ns:
                next_step = PlanStep(**ns)

        logger.info(
            "[Chat] user='%s' step=%s history=%d",
            user_message[:30],
            current_step.step_number if current_step else "-",
            len(chat_history),
        )

        pipeline_input = PipelineInput(
            pipeline_type="user_action",
            image_bytes=image_bytes,
            user_message=user_message,
            current_step=current_step,
            next_step=next_step,
            recent_observations=recent_observations,
            plan_steps=plan_steps,
            plan_source_id=session.plan_source_id if session else "",
            total_steps=total_steps,
            chat_history=chat_history,
        )

        result = await run_two_stage_pipeline(
            input_data=pipeline_input,
            guide_service=self._guide_service,
            llm_client=self._llm,
            hq_client=self._hq,
            rag_client=self._rag,
            embedding_client=self._emb,
            session=session,
            session_store=self._session_store,
        )

        logger.info(
            "[Chat] → %s msg='%s' blocks=%d escalated=%s",
            result.source, result.message[:40], len(result.blocks), result.escalated,
        )

        return {
            "message": result.message,
            "blocks": result.blocks,
            "escalated": result.escalated,
        }
