import logging

from src.config import settings
from src.infrastructure.repositories.plan_repository import load_plan
from src.domain.guide.service import GuideService
from src.infrastructure.agent.graph import GuideState, build_guide_graph
from src.infrastructure.llm.base import LLMClient
from src.infrastructure.rag.embeddings import EmbeddingClient
from src.infrastructure.rag.milvus import MilvusRAGClient

from .plan_use_case import get_generated_steps
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
    ):
        self._guide_service = guide_service
        self._llm_client = llm_client
        self._graph = build_guide_graph(
            guide_service, llm_client, embedding_client, hq_client, rag_client
        ).compile()

    async def judge(
        self,
        image_bytes: bytes,
        source_id: str,
        current_step_index: int,
        recent_observations: list[str] | None = None,
        is_calibration: bool = False,
    ) -> JudgeResponse:
        # プラン読み込み (静的ファイル → 生成キャッシュの順で検索)
        steps = load_plan(source_id, settings.static_dir)
        if not steps:
            steps = get_generated_steps(source_id)
        if not steps:
            return JudgeResponse(
                judgment="anomaly",
                confidence=0.0,
                message=f"プラン '{source_id}' が見つかりません",
                current_step_index=current_step_index,
            )

        if current_step_index < 0 or current_step_index >= len(steps):
            current_step_index = 0

        # LangGraph で判定実行
        initial_state: GuideState = {
            "image_bytes": image_bytes,
            "current_step_index": current_step_index,
            "plan_steps": steps,
            "recent_observations": recent_observations or [],
            "has_change": True,
            "is_calibration": is_calibration,
        }

        result = await self._graph.ainvoke(initial_state)

        # キャリブレーション時は推定されたステップインデックスを返す
        result_step_idx = result.get("current_step_index", current_step_index)

        return JudgeResponse(
            judgment=result.get("judgment", "continue"),
            confidence=result.get("confidence", 0.5),
            message=result.get("message", ""),
            current_step_index=result_step_idx,
            blocks=result.get("blocks", []),
            escalated=result.get("escalated", False),
        )
