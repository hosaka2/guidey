import logging

from src.domain.guide.model import PlanStep
from src.domain.guide.service import GuideService
from src.infrastructure.agent.graph import GuideState, build_guide_graph
from src.infrastructure.llm.base import LLMClient
from src.infrastructure.rag.embeddings import EmbeddingClient
from src.infrastructure.rag.milvus import MilvusRAGClient
from src.infrastructure.session.models import Session

from .schemas import JudgeResponse

logger = logging.getLogger(__name__)


class JudgeUseCase:
    def __init__(
        self,
        guide_service: GuideService,
        llm_client: LLMClient,
        embedding_client: EmbeddingClient | None = None,
        hq_client: LLMClient | None = None,
        rag_client: MilvusRAGClient | None = None,
        session_store=None,
    ):
        self._guide_service = guide_service
        self._llm_client = llm_client
        self._embedding_client = embedding_client
        self._hq_client = hq_client
        self._rag_client = rag_client
        self._session_store = session_store

    async def judge(
        self,
        image_bytes: bytes,
        session: Session,
        is_calibration: bool = False,
        pending_message: str = "",
        pending_blocks: list[dict] | None = None,
    ) -> JudgeResponse:
        steps = [PlanStep(**s) for s in session.plan_steps]
        if not steps:
            return JudgeResponse(
                judgment="anomaly", confidence=0.0,
                message=f"プラン '{session.plan_source_id}' にステップがありません",
                current_step_index=session.current_step_index,
            )

        idx = session.current_step_index
        if idx < 0 or idx >= len(steps):
            idx = 0

        # session ごとに graph を構築 (session/store をクロージャでキャプチャ)
        graph = build_guide_graph(
            self._guide_service, self._llm_client,
            self._embedding_client, self._hq_client, self._rag_client,
            session=session, session_store=self._session_store,
        ).compile()

        initial_state: GuideState = {
            "image_bytes": image_bytes,
            "current_step_index": idx,
            "total_steps": session.total_steps,
            "plan_steps": steps,
            "plan_source_id": session.plan_source_id,
            "recent_observations": session.recent_observations,
            "current_step_duration_sec": session.get_step_duration_sec(),
            "pending_message": pending_message,
            "pending_blocks": pending_blocks or [],
            "is_calibration": is_calibration,
        }

        result = await graph.ainvoke(initial_state)

        return JudgeResponse(
            judgment=result.get("judgment", "continue"),
            confidence=result.get("confidence", 0.5),
            message=result.get("message", ""),
            current_step_index=result.get("current_step_index", idx),
            blocks=result.get("blocks", []),
            escalated=result.get("escalated", False),
        )
