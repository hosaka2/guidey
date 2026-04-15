import logging
from pathlib import Path

from fastapi import Depends

from src.application.guide.chat_use_case import ChatUseCase
from src.application.guide.judge_use_case import JudgeUseCase
from src.application.guide.plan_use_case import PlanGenerateUseCase
from src.application.guide.use_case import GuideUseCase
from src.config import settings
from src.domain.guide.service import GuideService
from src.infrastructure.llm.base import LLMClient
from src.infrastructure.llm.factory import get_hq_llm_client, get_llm_client
from src.infrastructure.rag.bm25 import BM25Index
from src.infrastructure.rag.embeddings import EmbeddingClient
from src.infrastructure.rag.hybrid import HybridSearchClient
from src.infrastructure.rag.milvus import MilvusRAGClient

logger = logging.getLogger(__name__)

# シングルトン
_rag_client: MilvusRAGClient | None = None
_embedding_client: EmbeddingClient | None = None
_hybrid_client: HybridSearchClient | None = None
_bm25_index: BM25Index | None = None


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
    # BM25インデックスは初回は空、データ登録時に構築される
    _hybrid_client = HybridSearchClient(rag_client, _bm25_index)
    return _hybrid_client


def get_guide_use_case(
    guide_service: GuideService = Depends(get_guide_service),
    llm_client: LLMClient = Depends(get_llm_client),
    rag_client: MilvusRAGClient | None = Depends(get_rag_client),
    embedding_client: EmbeddingClient | None = Depends(get_embedding_client),
    hybrid_client: HybridSearchClient | None = Depends(get_hybrid_client),
) -> GuideUseCase:
    return GuideUseCase(
        guide_service=guide_service,
        llm_client=llm_client,
        rag_client=rag_client,
        embedding_client=embedding_client,
        hybrid_client=hybrid_client,
    )


def get_judge_use_case(
    guide_service: GuideService = Depends(get_guide_service),
    llm_client: LLMClient = Depends(get_llm_client),
    embedding_client: EmbeddingClient | None = Depends(get_embedding_client),
    hq_client: LLMClient = Depends(get_hq_llm_client),
    rag_client: MilvusRAGClient | None = Depends(get_rag_client),
) -> JudgeUseCase:
    return JudgeUseCase(
        guide_service=guide_service,
        llm_client=llm_client,
        embedding_client=embedding_client,
        hq_client=hq_client,
        rag_client=rag_client,
    )


def get_chat_use_case(
    guide_service: GuideService = Depends(get_guide_service),
    llm_client: LLMClient = Depends(get_llm_client),
    hq_client: LLMClient = Depends(get_hq_llm_client),
    rag_client: MilvusRAGClient | None = Depends(get_rag_client),
    embedding_client: EmbeddingClient | None = Depends(get_embedding_client),
) -> ChatUseCase:
    return ChatUseCase(
        guide_service=guide_service,
        llm_client=llm_client,
        hq_client=hq_client,
        rag_client=rag_client,
        embedding_client=embedding_client,
    )


def get_plan_generate_use_case(
    guide_service: GuideService = Depends(get_guide_service),
    llm_client: LLMClient = Depends(get_hq_llm_client),  # 高品質版
    rag_client: MilvusRAGClient | None = Depends(get_rag_client),
    embedding_client: EmbeddingClient | None = Depends(get_embedding_client),
) -> PlanGenerateUseCase:
    return PlanGenerateUseCase(
        guide_service=guide_service,
        llm_client=llm_client,
        rag_client=rag_client,
        embedding_client=embedding_client,
    )
