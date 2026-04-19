"""FastAPI DI コンテナ.

層構造:
  - Infrastructure: Checkpointer, LLM クライアント, Graph, AgentClient
  - Application (UseCase): 業務ロジック / オーケストレーション。統一感のため pass-through でも必ず経由
  - Routes: 入力検証 + UseCase 呼び出し + SSE ラップのみ
"""

import logging
from pathlib import Path

from fastapi import Depends
from langgraph.checkpoint.redis.aio import AsyncRedisSaver
from langgraph.graph.state import CompiledStateGraph

from src.application.guide.usecases.analyze_use_case import AnalyzeUseCase
from src.application.guide.usecases.chat_use_case import ChatUseCase
from src.application.guide.usecases.feedback_use_case import FeedbackUseCase
from src.application.guide.usecases.periodic_use_case import PeriodicUseCase
from src.application.guide.usecases.plan_query_use_case import PlanQueryUseCase
from src.application.guide.usecases.plan_use_case import PlanGenerateUseCase
from src.application.guide.usecases.session_use_case import SessionUseCase
from src.config import settings
from src.domain.guide.service import GuideService
from src.infrastructure.agent.agent import AgentClient
from src.infrastructure.agent.graph import build_guide_graph
from src.infrastructure.llm.base import LLMClient
from src.infrastructure.llm.factory import get_hq_llm_client, get_llm_client
from src.infrastructure.rag.bm25 import BM25Index
from src.infrastructure.rag.embeddings import EmbeddingClient
from src.infrastructure.rag.hybrid import HybridSearchClient
from src.infrastructure.rag.milvus import MilvusRAGClient

logger = logging.getLogger(__name__)

# === シングルトン ===
_rag_client: MilvusRAGClient | None = None
_embedding_client: EmbeddingClient | None = None
_hybrid_client: HybridSearchClient | None = None
_bm25_index: BM25Index | None = None
_checkpointer: AsyncRedisSaver | None = None
_guide_graph: CompiledStateGraph | None = None
_agent_client: AgentClient | None = None


# === Infrastructure layer ===


async def get_checkpointer() -> AsyncRedisSaver:
    """AsyncRedisSaver のシングルトン。初回に asetup() でインデックス作成。"""
    global _checkpointer
    if _checkpointer is None:
        _checkpointer = AsyncRedisSaver(
            redis_url=settings.redis_url,
            ttl={
                "default_ttl": settings.session_ttl_min,
                "refresh_on_read": True,
            },
        )
        await _checkpointer.asetup()
        logger.info(
            "Checkpointer ready (%s, ttl=%dmin)",
            settings.redis_url,
            settings.session_ttl_min,
        )
    return _checkpointer


def get_guide_service() -> GuideService:
    return GuideService()


def get_rag_client() -> MilvusRAGClient | None:
    global _rag_client
    if _rag_client is not None:
        return _rag_client
    db_path = Path(settings.milvus_db_path)
    if not db_path.exists():
        logger.info("Milvus DB not found, RAG disabled")
        return None
    _rag_client = MilvusRAGClient()
    return _rag_client


def get_embedding_client() -> EmbeddingClient | None:
    global _embedding_client
    if _embedding_client is not None:
        return _embedding_client
    try:
        _embedding_client = EmbeddingClient()
        return _embedding_client
    except Exception:
        logger.warning("Embedding client init failed, RAG disabled", exc_info=True)
        return None


def get_hybrid_client(
    rag_client: MilvusRAGClient | None = Depends(get_rag_client),
) -> HybridSearchClient | None:
    global _hybrid_client, _bm25_index
    if _hybrid_client is not None:
        return _hybrid_client
    if not rag_client:
        return None
    _bm25_index = BM25Index()
    _hybrid_client = HybridSearchClient(rag_client, _bm25_index)
    return _hybrid_client


async def get_guide_graph(
    guide_service: GuideService = Depends(get_guide_service),
    llm_client: LLMClient = Depends(get_llm_client),
    hq_client: LLMClient = Depends(get_hq_llm_client),
    rag_client: MilvusRAGClient | None = Depends(get_rag_client),
    embedding_client: EmbeddingClient | None = Depends(get_embedding_client),
) -> CompiledStateGraph:
    """GuideGraph のシングルトン (checkpointer 付き)。"""
    global _guide_graph
    if _guide_graph is None:
        checkpointer = await get_checkpointer()
        _guide_graph = build_guide_graph(
            guide_service=guide_service,
            llm_client=llm_client,
            hq_client=hq_client,
            rag_client=rag_client,
            embedding_client=embedding_client,
            checkpointer=checkpointer,
        )
        logger.info("GuideGraph compiled with checkpointer")
    return _guide_graph


async def get_agent_client(
    graph: CompiledStateGraph = Depends(get_guide_graph),
) -> AgentClient:
    """AgentClient のシングルトン (graph 操作の唯一の入口)。"""
    global _agent_client
    if _agent_client is None:
        _agent_client = AgentClient(graph=graph)
    return _agent_client


# === Application layer (UseCase) ===


async def get_periodic_use_case(
    agent: AgentClient = Depends(get_agent_client),
) -> PeriodicUseCase:
    return PeriodicUseCase(agent=agent)


async def get_chat_use_case(
    agent: AgentClient = Depends(get_agent_client),
) -> ChatUseCase:
    return ChatUseCase(agent=agent)


async def get_session_use_case(
    agent: AgentClient = Depends(get_agent_client),
) -> SessionUseCase:
    return SessionUseCase(agent=agent)


async def get_plan_query_use_case(
    agent: AgentClient = Depends(get_agent_client),
) -> PlanQueryUseCase:
    return PlanQueryUseCase(agent=agent)


def get_feedback_use_case() -> FeedbackUseCase:
    return FeedbackUseCase()


# === 1-shot 系 (Graph 非依存) ===


def get_analyze_use_case(
    guide_service: GuideService = Depends(get_guide_service),
    llm_client: LLMClient = Depends(get_llm_client),
    rag_client: MilvusRAGClient | None = Depends(get_rag_client),
    embedding_client: EmbeddingClient | None = Depends(get_embedding_client),
    hybrid_client: HybridSearchClient | None = Depends(get_hybrid_client),
) -> AnalyzeUseCase:
    return AnalyzeUseCase(
        guide_service=guide_service,
        llm_client=llm_client,
        rag_client=rag_client,
        embedding_client=embedding_client,
        hybrid_client=hybrid_client,
    )


def get_plan_generate_use_case(
    guide_service: GuideService = Depends(get_guide_service),
    llm_client: LLMClient = Depends(get_hq_llm_client),
    rag_client: MilvusRAGClient | None = Depends(get_rag_client),
    embedding_client: EmbeddingClient | None = Depends(get_embedding_client),
) -> PlanGenerateUseCase:
    return PlanGenerateUseCase(
        guide_service=guide_service,
        llm_client=llm_client,
        rag_client=rag_client,
        embedding_client=embedding_client,
    )
